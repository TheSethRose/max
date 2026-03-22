import { z } from "zod";
import type { AIClient, AISession, AIToolDefinition } from "../ai/types.js";
import { defineAiTool } from "../ai/types.js";
import { getDb, addMemory, searchMemories, removeMemory } from "../store/db.js";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, sep, resolve } from "path";
import { homedir } from "os";
import { listSkills, createSkill, removeSkill } from "./skills.js";
import { config, persistModel } from "../config.js";
import { DB_PATH, ENV_PATH, SESSIONS_DIR } from "../paths.js";
import { getCurrentSourceChannel } from "./orchestrator.js";
import { getRouterConfig, type RouteResult, updateRouterConfig } from "./router.js";
import { getWorkerSystemMessage } from "./system-message.js";
import { appendSafetyLogEntry, getWorkspaceProfileDir, renderProfileContext } from "../workspace.js";

function isTimeoutError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /timeout|timed?\s*out/i.test(msg);
}

function formatWorkerError(workerName: string, startedAt: number, timeoutMs: number, err: unknown): string {
  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  const limit = Math.round(timeoutMs / 1000);
  const msg = err instanceof Error ? err.message : String(err);

  if (isTimeoutError(err)) {
    return `Worker '${workerName}' timed out after ${elapsed}s (limit: ${limit}s). The task was still running but had to be stopped. To allow more time, set WORKER_TIMEOUT=${timeoutMs * 2} in ~/.max/.env`;
  }
  return `Worker '${workerName}' failed after ${elapsed}s: ${msg}`;
}

const PROFILE_WORKSPACE_DIR = resolve(getWorkspaceProfileDir());

function isProfileWorkspaceDir(workingDir: string): boolean {
  const resolvedDir = resolve(workingDir);
  return resolvedDir === PROFILE_WORKSPACE_DIR || resolvedDir.startsWith(PROFILE_WORKSPACE_DIR + sep);
}

function withProfileWorkspaceGuidance(workingDir: string, prompt: string): string {
  if (!isProfileWorkspaceDir(workingDir)) {
    return prompt;
  }

  return [
    `Profile workspace: ${workingDir}`,
    "This is Max's user-owned profile workspace, not the Max source repo.",
    "If you intentionally complete bootstrap by deleting BOOTSTRAP.md, treat the missing file as success.",
    "Delete BOOTSTRAP.md only after the other profile updates are finished.",
    "After intentionally deleting or renaming a file, do not read the old path again. If you need to confirm the result, use a directory listing or file-existence check instead.",
    "Task:",
    prompt,
  ].join("\n\n");
}

const BLOCKED_WORKER_DIRS = [
  ".ssh", ".gnupg", ".aws", ".azure", ".config/gcloud",
  ".kube", ".docker", ".npmrc", ".pypirc",
];

const MAX_CONCURRENT_WORKERS = 5;
const WORKER_PROGRESS_INITIAL_CHARS = 80;
const WORKER_PROGRESS_MIN_INCREMENT_CHARS = 140;
const WORKER_PROGRESS_MIN_INTERVAL_MS = 8_000;

export interface WorkerInfo {
  name: string;
  session: AISession;
  workingDir: string;
  status: "idle" | "running" | "error";
  lastOutput?: string;
  /** Timestamp (ms) when the worker started its current task. */
  startedAt?: number;
  /** Channel that created this worker — completions route back here. */
  originChannel?: "telegram" | "tui" | "all" | "none";
}

export interface ToolDeps {
  client: AIClient;
  getWorkerClient: () => Promise<AIClient>;
  getLastRouteResult: () => RouteResult | undefined;
  workers: Map<string, WorkerInfo>;
  onWorkerComplete: (name: string, result: string) => void;
  onWorkerProgress: (name: string, update: string) => void;
}

function normalizeProgressText(text: string): string {
  return text.replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").trim();
}

function formatProgressUpdate(workerName: string, content: string): string {
  return `[${workerName}] ${content}`;
}

function summarizeSafetyLogText(text: string, maxChars = 180): string {
  const normalized = normalizeProgressText(text).replace(/\s+/g, " ");
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars - 1)}…`;
}

function dispatchWorkerTask(
  deps: ToolDeps,
  worker: WorkerInfo,
  prompt: string,
): void {
  worker.status = "running";
  worker.startedAt = Date.now();
  worker.lastOutput = undefined;

  const db = getDb();
  db.prepare(`UPDATE worker_sessions SET status = 'running', updated_at = CURRENT_TIMESTAMP WHERE name = ?`).run(
    worker.name,
  );

  const timeoutMs = config.workerTimeoutMs;
  let streamedText = "";
  let lastPublishedNormalized = "";
  let publishedChars = 0;
  let lastPublishedAt = 0;

  appendSafetyLogEntry(`Dispatched worker '${worker.name}' in ${worker.workingDir}`, "running");

  const maybePublishProgress = (force = false): void => {
    const normalized = normalizeProgressText(streamedText);
    if (!normalized || normalized === lastPublishedNormalized) {
      return;
    }

    const newlyAdded = normalizeProgressText(
      normalized.startsWith(lastPublishedNormalized)
        ? normalized.slice(lastPublishedNormalized.length)
        : normalized,
    );
    if (!newlyAdded) {
      return;
    }

    if (!force) {
      const nextThreshold = publishedChars === 0
        ? WORKER_PROGRESS_INITIAL_CHARS
        : publishedChars + WORKER_PROGRESS_MIN_INCREMENT_CHARS;
      if (normalized.length < nextThreshold) {
        return;
      }
      if (publishedChars > 0 && Date.now() - lastPublishedAt < WORKER_PROGRESS_MIN_INTERVAL_MS) {
        return;
      }
    }

    lastPublishedNormalized = normalized;
    publishedChars = normalized.length;
    lastPublishedAt = Date.now();
    deps.onWorkerProgress(worker.name, formatProgressUpdate(worker.name, newlyAdded));
  };

  const unsubscribeDelta = worker.session.on("message.delta", (event) => {
    streamedText += event.data.deltaText;
    maybePublishProgress();
  });

  const unsubscribeTool = worker.session.on("tool.complete", () => {
    maybePublishProgress(true);
  });

  worker.session.sendAndWait({ prompt }, timeoutMs).then((result) => {
    worker.lastOutput = result?.content || normalizeProgressText(streamedText) || "No response";
    appendSafetyLogEntry(
      `Worker '${worker.name}' completed: ${summarizeSafetyLogText(worker.lastOutput)}`,
      "ok",
    );
    deps.onWorkerComplete(worker.name, worker.lastOutput);
  }).catch((err) => {
    const errMsg = formatWorkerError(worker.name, worker.startedAt!, timeoutMs, err);
    worker.lastOutput = errMsg;
    appendSafetyLogEntry(
      `Worker '${worker.name}' failed: ${summarizeSafetyLogText(errMsg)}`,
      "error",
    );
    deps.onWorkerComplete(worker.name, errMsg);
  }).finally(() => {
    unsubscribeDelta();
    unsubscribeTool();
    worker.session.destroy().catch(() => {});
    deps.workers.delete(worker.name);
    getDb().prepare(`DELETE FROM worker_sessions WHERE name = ?`).run(worker.name);
  });
}

export function createTools(deps: ToolDeps): AIToolDefinition[] {
  return [
    defineAiTool("create_worker_session", {
      description:
        "Create a new coding worker session in a specific directory. " +
        "Use for coding tasks, debugging, and file operations. " +
        "Returns confirmation with session name.",
      parameters: z.object({
        name: z.string().describe("Short descriptive name for the session, e.g. 'auth-fix'"),
        working_dir: z.string().describe("Absolute path to the directory to work in"),
        initial_prompt: z.string().optional().describe("Optional initial prompt to send to the worker"),
      }),
      handler: async (args) => {
        if (deps.workers.has(args.name)) {
          return `Worker '${args.name}' already exists. Use send_to_worker to interact with it.`;
        }

        const home = homedir();
        const resolvedDir = resolve(args.working_dir);
        for (const blocked of BLOCKED_WORKER_DIRS) {
          const blockedPath = join(home, blocked);
          if (resolvedDir === blockedPath || resolvedDir.startsWith(blockedPath + sep)) {
            return `Refused: '${args.working_dir}' is a sensitive directory. Workers cannot operate in ${blocked}.`;
          }
        }

        if (deps.workers.size >= MAX_CONCURRENT_WORKERS) {
          const names = Array.from(deps.workers.keys()).join(", ");
          return `Worker limit reached (${MAX_CONCURRENT_WORKERS}). Active: ${names}. Kill a session first.`;
        }

        const workerClient = await deps.getWorkerClient();
        const workerWorkspaceContext = renderProfileContext("worker");
        const session = await workerClient.createSession({
          model: config.aiModel,
          configDir: SESSIONS_DIR,
          workingDirectory: args.working_dir,
          systemMessage: {
            content: getWorkerSystemMessage(workerWorkspaceContext || undefined),
          },
        });

        const worker: WorkerInfo = {
          name: args.name,
          session,
          workingDir: args.working_dir,
          status: "idle",
          originChannel: getCurrentSourceChannel(),
        };
        deps.workers.set(args.name, worker);
        appendSafetyLogEntry(`Created worker session '${args.name}' in ${args.working_dir}`, "created");

        // Persist to SQLite
        const db = getDb();
        db.prepare(
          `INSERT OR REPLACE INTO worker_sessions (name, session_id, working_dir, status)
           VALUES (?, ?, ?, 'idle')`
        ).run(args.name, session.sessionId, args.working_dir);

        if (args.initial_prompt) {
          dispatchWorkerTask(
            deps,
            worker,
            `Working directory: ${args.working_dir}\n\n${withProfileWorkspaceGuidance(args.working_dir, args.initial_prompt)}`,
          );

          return `Worker '${args.name}' created in ${args.working_dir}. Task dispatched — I'll notify you when it's done.`;
        }

        return `Worker '${args.name}' created in ${args.working_dir}. Use send_to_worker to send it prompts.`;
      },
    }),

    defineAiTool("send_to_worker", {
      description:
        "Send a prompt to an existing worker session and wait for its response. " +
        "Use for follow-up instructions or questions about ongoing work.",
      parameters: z.object({
        name: z.string().describe("Name of the worker session"),
        prompt: z.string().describe("The prompt to send"),
      }),
      handler: async (args) => {
        const worker = deps.workers.get(args.name);
        if (!worker) {
          return `No worker named '${args.name}'. Use list_sessions to see available workers.`;
        }
        if (worker.status === "running") {
          return `Worker '${args.name}' is currently busy. Wait for it to finish or kill it.`;
        }

        dispatchWorkerTask(deps, worker, withProfileWorkspaceGuidance(worker.workingDir, args.prompt));

        return `Task dispatched to worker '${args.name}'. I'll notify you when it's done.`;
      },
    }),

    defineAiTool("list_sessions", {
      description: "List all active worker sessions with their name, status, and working directory.",
      parameters: z.object({}),
      handler: async () => {
        if (deps.workers.size === 0) {
          return "No active worker sessions.";
        }
        const lines = Array.from(deps.workers.values()).map(
          (w) => `• ${w.name} (${w.workingDir}) — ${w.status}`
        );
        return `Active sessions:\n${lines.join("\n")}`;
      },
    }),

    defineAiTool("check_session_status", {
      description: "Get detailed status of a specific worker session, including its last output.",
      parameters: z.object({
        name: z.string().describe("Name of the worker session"),
      }),
      handler: async (args) => {
        const worker = deps.workers.get(args.name);
        if (!worker) {
          return `No worker named '${args.name}'.`;
        }
        const output = worker.lastOutput
          ? `\n\nLast output:\n${worker.lastOutput.slice(0, 2000)}`
          : "";
        return `Worker '${args.name}'\nDirectory: ${worker.workingDir}\nStatus: ${worker.status}${output}`;
      },
    }),

    defineAiTool("kill_session", {
      description: "Terminate a worker session and free its resources.",
      parameters: z.object({
        name: z.string().describe("Name of the worker session to kill"),
      }),
      handler: async (args) => {
        const worker = deps.workers.get(args.name);
        if (!worker) {
          return `No worker named '${args.name}'.`;
        }
        try {
          await worker.session.destroy();
        } catch {
          // Session may already be gone
        }
        deps.workers.delete(args.name);

        const db = getDb();
        db.prepare(`DELETE FROM worker_sessions WHERE name = ?`).run(args.name);

        appendSafetyLogEntry(`Terminated worker '${args.name}'`, "terminated");

        return `Worker '${args.name}' terminated.`;
      },
    }),

    defineAiTool("list_machine_sessions", {
      description:
        "List ALL Copilot CLI sessions on this machine — including sessions started from VS Code, " +
        "the terminal, or other tools. Shows session ID, summary, working directory. " +
        "Use this when the user asks about existing sessions running on the machine. " +
        "By default shows the 20 most recently active sessions. Copilot-only.",
      parameters: z.object({
        cwd_filter: z.string().optional().describe("Optional: only show sessions whose working directory contains this string"),
        limit: z.number().int().min(1).max(100).optional().describe("Max sessions to return (default 20)"),
      }),
      handler: async (args) => {
        if (config.aiProvider !== "copilot") {
          return "Machine session discovery is only available when AI_PROVIDER=copilot.";
        }
        const sessionStateDir = join(homedir(), ".copilot", "session-state");
        const limit = args.limit || 20;

        let entries: { id: string; cwd: string; summary: string; updatedAt: Date }[] = [];

        try {
          const dirs = readdirSync(sessionStateDir);
          for (const dir of dirs) {
            const yamlPath = join(sessionStateDir, dir, "workspace.yaml");
            try {
              const content = readFileSync(yamlPath, "utf-8");
              const parsed = parseSimpleYaml(content);
              if (args.cwd_filter && !parsed.cwd?.includes(args.cwd_filter)) continue;
              entries.push({
                id: parsed.id || dir,
                cwd: parsed.cwd || "unknown",
                summary: parsed.summary || "",
                updatedAt: parsed.updated_at ? new Date(parsed.updated_at) : new Date(0),
              });
            } catch {
              // Skip dirs without valid workspace.yaml
            }
          }
        } catch (err: unknown) {
          if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
            return "No Copilot sessions found on this machine (session state directory does not exist yet).";
          }
          return "Could not read session state directory.";
        }

        // Sort by most recently updated
        entries.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
        entries = entries.slice(0, limit);

        if (entries.length === 0) {
          return "No Copilot sessions found on this machine.";
        }

        const lines = entries.map((s) => {
          const age = formatAge(s.updatedAt);
          const summary = s.summary ? ` — ${s.summary}` : "";
          return `• ID: ${s.id}\n  ${s.cwd} (${age})${summary}`;
        });

        return `Found ${entries.length} session(s) (most recent first):\n${lines.join("\n")}`;
      },
    }),

    defineAiTool("attach_machine_session", {
      description:
        "Attach to an existing Copilot CLI session on this machine (e.g. one started from VS Code or terminal). " +
        "Resumes the session and adds it as a managed worker so you can send prompts to it. Copilot-only.",
      parameters: z.object({
        session_id: z.string().describe("The session ID to attach to (from list_machine_sessions)"),
        name: z.string().describe("A short name to reference this session by, e.g. 'vscode-main'"),
      }),
      handler: async (args) => {
        if (config.aiProvider !== "copilot") {
          return "Attaching to existing machine sessions is only available when AI_PROVIDER=copilot.";
        }
        if (deps.workers.has(args.name)) {
          return `A worker named '${args.name}' already exists. Choose a different name.`;
        }

        try {
          const workerClient = await deps.getWorkerClient();
          const session = await workerClient.resumeSession(args.session_id, {
            model: config.aiModel,
          });

          const worker: WorkerInfo = {
            name: args.name,
            session,
            workingDir: "(attached)",
            status: "idle",
            originChannel: getCurrentSourceChannel(),
          };
          deps.workers.set(args.name, worker);

          const db = getDb();
          db.prepare(
            `INSERT OR REPLACE INTO worker_sessions (name, session_id, working_dir, status)
             VALUES (?, ?, '(attached)', 'idle')`
          ).run(args.name, args.session_id);

          return `Attached to session ${args.session_id.slice(0, 8)}… as worker '${args.name}'. You can now send_to_worker to interact with it.`;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return `Failed to attach to session: ${msg}`;
        }
      },
    }),

    defineAiTool("list_skills", {
      description:
        "List all available skills that Max knows. Skills are instruction documents that teach Max " +
        "how to use external tools and services (e.g. Gmail, browser automation, YouTube transcripts). " +
        "Shows skill name, description, and whether it's a local or global skill.",
      parameters: z.object({}),
      handler: async () => {
        const skills = listSkills();
        if (skills.length === 0) {
          return "No skills installed yet. Use learn_skill to teach me something new.";
        }
        const lines = skills.map(
          (s) => `• ${s.name} (${s.source}) — ${s.description}`
        );
        return `Available skills (${skills.length}):\n${lines.join("\n")}`;
      },
    }),

    defineAiTool("learn_skill", {
      description:
        "Teach Max a new skill by creating a SKILL.md instruction file. Use this when the user asks Max " +
        "to do something it doesn't know how to do yet (e.g. 'check my email', 'search the web'). " +
        "First, use a worker session to research what CLI tools are available on the system (run 'which', " +
        "'--help', etc.), then create the skill with the instructions you've learned. " +
        "The skill becomes available on the next message (no restart needed).",
      parameters: z.object({
        slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).describe("Short kebab-case identifier for the skill, e.g. 'gmail', 'web-search'"),
        name: z.string().refine(s => !s.includes('\n'), "must be single-line").describe("Human-readable name for the skill, e.g. 'Gmail', 'Web Search'"),
        description: z.string().refine(s => !s.includes('\n'), "must be single-line").describe("One-line description of when to use this skill"),
        instructions: z.string().describe(
          "Markdown instructions for how to use the skill. Include: what CLI tool to use, " +
          "common commands with examples, authentication steps if needed, tips and gotchas. " +
          "This becomes the SKILL.md content body."
        ),
      }),
      handler: async (args) => {
        return createSkill(args.slug, args.name, args.description, args.instructions);
      },
    }),

    defineAiTool("uninstall_skill", {
      description:
        "Remove a skill from Max's local skills directory (~/.max/skills/). " +
        "The skill will no longer be available on the next message. " +
        "Only works for local skills — bundled and global skills cannot be removed this way.",
      parameters: z.object({
        slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).describe("The kebab-case slug of the skill to remove, e.g. 'gmail', 'web-search'"),
      }),
      handler: async (args) => {
        const result = removeSkill(args.slug);
        return result.message;
      },
    }),

    defineAiTool("list_models", {
      description:
        "List all available runtime models for the active provider. Shows model id, name, and billing tier. " +
        "Marks the currently active model. Use when the user asks what models are available " +
        "or wants to know which model is in use.",
      parameters: z.object({}),
      handler: async () => {
        try {
          const models = await deps.client.listModels();
          if (models.length === 0) {
            return "No models available.";
          }
          const current = config.aiModel;
          const lines = models.map((m) => {
            const active = m.id === current ? " ← active" : "";
            const billing = m.billingMultiplier !== undefined ? ` (${m.billingMultiplier}x)` : "";
            return `• ${m.id}${billing}${active}`;
          });
          return `Available models (${models.length}):\n${lines.join("\n")}\n\nCurrent: ${current}`;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return `Failed to list models: ${msg}`;
        }
      },
    }),

    defineAiTool("get_runtime_status", {
      description:
        "Show the current runtime/provider status for Max. Use when the user asks which model Max is using, " +
        "whether auto mode is on, what model was used most recently, or where model/auto settings are stored.",
      parameters: z.object({}),
      handler: async () => {
        const router = getRouterConfig();
        const lastRoute = deps.getLastRouteResult();
        const lines = [
          `Provider: ${config.aiProvider}`,
          `Configured model: ${config.aiModel}`,
          `Classifier model: ${config.classifierModel}`,
          `Auto mode: ${router.enabled ? "on" : "off"}`,
        ];

        if (router.enabled) {
          lines.push(
            "Auto-routing tiers:",
            `• fast: ${router.tierModels.fast}`,
            `• standard: ${router.tierModels.standard}`,
            `• premium: ${router.tierModels.premium}`,
          );
        }

        if (lastRoute) {
          const lastTier = lastRoute.overrideName ? `${lastRoute.overrideName} override` : (lastRoute.tier ?? "manual");
          lines.push(`Last routed model: ${lastRoute.model} (${lastRoute.routerMode}, ${lastTier})`);
        } else {
          lines.push("Last routed model: none yet since startup");
        }

        lines.push(
          "Persistence:",
          `• Fixed model is stored in ${ENV_PATH} via AI_MODEL`,
          `• Auto mode is stored in ${DB_PATH} as the 'router_config' state entry`,
        );

        return lines.join("\n");
      },
    }),

    defineAiTool("switch_model", {
      description:
        "Switch the active provider model Max uses for conversations. Takes effect on the next message. " +
        "The change is persisted across restarts. Use when the user asks to change or switch models.",
      parameters: z.object({
        model_id: z.string().describe("The model id to switch to (from list_models)"),
      }),
      handler: async (args) => {
        try {
          const models = await deps.client.listModels();
          const match = models.find((m) => m.id === args.model_id);
          if (!match) {
            const suggestions = models
              .filter((m) => m.id.includes(args.model_id) || m.id.toLowerCase().includes(args.model_id.toLowerCase()))
              .map((m) => m.id);
            const hint = suggestions.length > 0
              ? ` Did you mean: ${suggestions.join(", ")}?`
              : " Use list_models to see available options.";
            return `Model '${args.model_id}' not found.${hint}`;
          }

          const previous = config.aiModel;
          config.aiModel = args.model_id;
          persistModel(args.model_id);

          // Disable router when manually switching — user has explicit preference
          if (getRouterConfig().enabled) {
            updateRouterConfig({ enabled: false });
            return `Switched model from '${previous}' to '${args.model_id}'. Auto-routing disabled (use /auto or toggle_auto to re-enable). Takes effect on next message.`;
          }

          return `Switched model from '${previous}' to '${args.model_id}'. Takes effect on next message.`;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return `Failed to switch model: ${msg}`;
        }
      },
    }),

    defineAiTool("toggle_auto", {
      description:
        "Enable or disable automatic model routing (auto mode). When enabled, Max automatically picks " +
        "the best model (fast/standard/premium) for each message to save cost and optimize speed. " +
        "Use when the user asks to turn auto-routing on or off.",
      parameters: z.object({
        enabled: z.boolean().describe("true to enable auto-routing, false to disable"),
      }),
      handler: async (args) => {
        const updated = updateRouterConfig({ enabled: args.enabled });
        if (args.enabled) {
          const tiers = updated.tierModels;
          return `Auto-routing enabled. Tier models:\n• fast: ${tiers.fast}\n• standard: ${tiers.standard}\n• premium: ${tiers.premium}\n\nMax will automatically pick the best model for each message.`;
        }
        return `Auto-routing disabled. Using fixed model: ${config.aiModel}`;
      },
    }),

    defineAiTool("remember", {
      description:
        "Save something to Max's long-term memory. Use when the user says 'remember that...', " +
        "states a preference, shares a fact about themselves, or mentions something important " +
        "that should be remembered across conversations. Also use proactively when you detect " +
        "important information worth persisting.",
      parameters: z.object({
        category: z.enum(["preference", "fact", "project", "person", "routine"])
          .describe("Category: preference (likes/dislikes/settings), fact (general knowledge), project (codebase/repo info), person (people info), routine (schedules/habits)"),
        content: z.string().describe("The thing to remember — a concise, self-contained statement"),
        source: z.enum(["user", "auto"]).optional().describe("'user' if explicitly asked to remember, 'auto' if Max detected it (default: 'user')"),
      }),
      handler: async (args) => {
        const id = addMemory(args.category, args.content, args.source || "user");
        return `Remembered (#${id}, ${args.category}): "${args.content}"`;
      },
    }),

    defineAiTool("recall", {
      description:
        "Search Max's long-term memory for stored facts, preferences, or information. " +
        "Use when you need to look up something the user told you before, or when the user " +
        "asks 'do you remember...?' or 'what do you know about...?'",
      parameters: z.object({
        keyword: z.string().optional().describe("Search term to match against memory content"),
        category: z.enum(["preference", "fact", "project", "person", "routine"]).optional()
          .describe("Optional: filter by category"),
      }),
      handler: async (args) => {
        const results = searchMemories(args.keyword, args.category);
        if (results.length === 0) {
          return "No matching memories found.";
        }
        const lines = results.map(
          (m) => `• #${m.id} [${m.category}] ${m.content} (${m.source}, ${m.created_at})`
        );
        return `Found ${results.length} memory/memories:\n${lines.join("\n")}`;
      },
    }),

    defineAiTool("forget", {
      description:
        "Remove a specific memory from Max's long-term storage. Use when the user asks " +
        "to forget something, or when a memory is outdated/incorrect. Requires the memory ID " +
        "(use recall to find it first).",
      parameters: z.object({
        memory_id: z.number().int().describe("The memory ID to remove (from recall results)"),
      }),
      handler: async (args) => {
        const removed = removeMemory(args.memory_id);
        return removed
          ? `Memory #${args.memory_id} forgotten.`
          : `Memory #${args.memory_id} not found — it may have already been removed.`;
      },
    }),

    defineAiTool("restart_max", {
      description:
        "Restart the Max daemon process. Use when the user asks Max to restart himself, " +
        "or when a restart is needed to pick up configuration changes. " +
        "Spawns a new process and exits the current one.",
      parameters: z.object({
        reason: z.string().optional().describe("Optional reason for the restart"),
      }),
      handler: async (args) => {
        const reason = args.reason ? ` (${args.reason})` : "";
        // Dynamic import to avoid circular dependency
        const { restartDaemon } = await import("../daemon.js");
        // Schedule restart after returning the response
        setTimeout(() => {
          restartDaemon().catch((err) => {
            console.error("[max] Restart failed:", err);
          });
        }, 1000);
        return `Restarting Max${reason}. I'll be back in a few seconds.`;
      },
    }),
  ];
}

function formatAge(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function parseSimpleYaml(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const idx = line.indexOf(": ");
    if (idx > 0) {
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 2).trim();
      result[key] = value;
    }
  }
  return result;
}
