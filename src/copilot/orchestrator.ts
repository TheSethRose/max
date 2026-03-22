import { createTools, type WorkerInfo } from "./tools.js";
import { getOrchestratorSystemMessage } from "./system-message.js";
import { config, getDefaultAiModel } from "../config.js";
import { loadMcpConfig } from "./mcp-config.js";
import { getSkillDirectories } from "./skills.js";
import { getWorkerClient, resetClient } from "../ai/runtime.js";
import { clearConversationLog, logConversation, getState, setState, deleteState, getMemorySummary, getRecentConversation } from "../store/db.js";
import { SESSIONS_DIR } from "../paths.js";
import { resolveModel, type Tier, type RouteResult } from "./router.js";
import type { AIClient, AISession } from "../ai/types.js";
import { ensureWorkspaceProfile, hasActiveBootstrap, renderProfileContext, wrapPromptForBootstrap } from "../workspace.js";

const MAX_RETRIES = 3;
const RECONNECT_DELAYS_MS = [1_000, 3_000, 10_000];
const HEALTH_CHECK_INTERVAL_MS = 30_000;

const ORCHESTRATOR_SESSION_KEY = "orchestrator_session_id";

export type MessageSource =
  | { type: "telegram"; chatId: number; messageId: number }
  | { type: "tui"; connectionId: string }
  | { type: "background" }
  | { type: "heartbeat" };

export type ProactiveChannel = "telegram" | "tui" | "all" | "none";

export type MessageCallback = (text: string, done: boolean) => void;

type LogFn = (direction: "in" | "out", source: string, text: string) => void;
let logMessage: LogFn = () => {};

export function setMessageLogger(fn: LogFn): void {
  logMessage = fn;
}

// Proactive notification — sends unsolicited messages to the user on a specific channel
type ProactiveNotifyFn = (text: string, channel?: ProactiveChannel) => void;
let proactiveNotifyFn: ProactiveNotifyFn | undefined;

export function setProactiveNotify(fn: ProactiveNotifyFn): void {
  proactiveNotifyFn = fn;
}

let aiClient: AIClient | undefined;
const workers = new Map<string, WorkerInfo>();
let healthCheckTimer: ReturnType<typeof setInterval> | undefined;
let lastWorkspaceContext = "";

// Router state — tracks model across the session
let currentSessionModel: string | undefined;
let recentTiers: Tier[] = [];
let lastRouteResult: RouteResult | undefined;

export function getLastRouteResult(): RouteResult | undefined {
  return lastRouteResult;
}

// Persistent orchestrator session
let orchestratorSession: AISession | undefined;
// Coalesces concurrent ensureOrchestratorSession calls
let sessionCreatePromise: Promise<AISession> | undefined;

// Message queue — serializes access to the single persistent session
type QueuedMessage = {
  prompt: string;
  callback: MessageCallback;
  sourceChannel?: ProactiveChannel;
  resolve: (value: string) => void;
  reject: (err: unknown) => void;
};
const messageQueue: QueuedMessage[] = [];
let processing = false;
let currentCallback: MessageCallback | undefined;
/** The channel currently being processed — tools use this to tag new workers. */
let currentSourceChannel: ProactiveChannel | undefined;

/** Get the channel that originated the message currently being processed. */
export function getCurrentSourceChannel(): ProactiveChannel | undefined {
  return currentSourceChannel;
}

export function isOrchestratorBusy(): boolean {
  return processing || messageQueue.length > 0 || !!currentCallback;
}

function getSessionConfig() {
  const tools = createTools({
    client: aiClient!,
    getWorkerClient,
    getLastRouteResult,
    workers,
    onWorkerComplete: feedBackgroundResult,
  });
  const mcpServers = loadMcpConfig();
  const skillDirectories = getSkillDirectories();
  return { tools, mcpServers, skillDirectories };
}

/** Feed a background worker result into the orchestrator as a new turn. */
export function feedBackgroundResult(workerName: string, result: string): void {
  const worker = workers.get(workerName);
  const channel = worker?.originChannel;
  const prompt = `[Background task completed] Worker '${workerName}' finished:\n\n${result}`;
  sendToOrchestrator(
    prompt,
    { type: "background" },
    (_text, done) => {
      if (done && proactiveNotifyFn) {
        proactiveNotifyFn(_text, channel);
      }
    }
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Ensure the SDK client is connected, resetting if necessary. Coalesces concurrent resets. */
let resetPromise: Promise<AIClient> | undefined;
async function ensureClient(): Promise<AIClient> {
  if (aiClient && aiClient.getState() === "connected") {
    return aiClient;
  }
  if (!resetPromise) {
    console.log(`[max] Client not connected (state: ${aiClient?.getState() ?? "null"}), resetting…`);
    resetPromise = resetClient().then((c) => {
      console.log(`[max] Client reset successful, state: ${c.getState()}`);
      aiClient = c;
      return c;
    }).finally(() => { resetPromise = undefined; });
  }
  return resetPromise;
}

/** Start periodic health check that proactively reconnects the client. */
function startHealthCheck(): void {
  if (healthCheckTimer) return;
  healthCheckTimer = setInterval(async () => {
    if (!aiClient) return;
    try {
      const state = aiClient.getState();
      if (state !== "connected") {
        console.log(`[max] Health check: client state is '${state}', resetting…`);
        await ensureClient();
        // Session may need recovery after client reset
        orchestratorSession = undefined;
        currentSessionModel = undefined;
      }
    } catch (err) {
      console.error(`[max] Health check error:`, err instanceof Error ? err.message : err);
    }
  }, HEALTH_CHECK_INTERVAL_MS);
}

/** Create or resume the persistent orchestrator session. */
async function ensureOrchestratorSession(): Promise<AISession> {
  if (orchestratorSession) return orchestratorSession;
  // Coalesce concurrent callers — wait for an in-flight creation
  if (sessionCreatePromise) return sessionCreatePromise;

  sessionCreatePromise = createOrResumeSession();
  try {
    const session = await sessionCreatePromise;
    orchestratorSession = session;
    return session;
  } finally {
    sessionCreatePromise = undefined;
  }
}

/** Internal: actually create or resume a session (not concurrency-safe — use ensureOrchestratorSession). */
async function createOrResumeSession(): Promise<AISession> {
  const client = await ensureClient();
  const { tools, mcpServers, skillDirectories } = getSessionConfig();
  const memorySummary = getMemorySummary();
  ensureWorkspaceProfile();
  const workspaceContext = renderProfileContext("orchestrator");
  lastWorkspaceContext = workspaceContext;

  const persistence = {
    enabled: true,
    backgroundCompactionThreshold: 0.80,
    bufferExhaustionThreshold: 0.95,
  };

  // Try to resume a previous session
  const savedSessionId = getState(ORCHESTRATOR_SESSION_KEY);
  if (savedSessionId) {
    try {
      console.log(`[max] Resuming orchestrator session ${savedSessionId.slice(0, 8)}…`);
      const session = await client.resumeSession(savedSessionId, {
        model: config.aiModel,
        configDir: SESSIONS_DIR,
        streaming: true,
        systemMessage: {
          content: getOrchestratorSystemMessage(memorySummary || undefined, {
            selfEditEnabled: config.selfEditEnabled,
            workspaceContext: workspaceContext || undefined,
          }),
        },
        tools,
        mcpServers,
        skillDirectories,
        persistence,
      });
      console.log(`[max] Resumed orchestrator session successfully`);
      currentSessionModel = config.aiModel;
      return session;
    } catch (err) {
      console.log(`[max] Could not resume session: ${err instanceof Error ? err.message : err}. Creating new.`);
      deleteState(ORCHESTRATOR_SESSION_KEY);
    }
  }

  // Create a fresh session
  console.log(`[max] Creating new persistent orchestrator session`);
  const session = await client.createSession({
    model: config.aiModel,
    configDir: SESSIONS_DIR,
    streaming: true,
    systemMessage: {
      content: getOrchestratorSystemMessage(memorySummary || undefined, {
        selfEditEnabled: config.selfEditEnabled,
        workspaceContext: workspaceContext || undefined,
      }),
    },
    tools,
    mcpServers,
    skillDirectories,
    persistence,
  });

  // Persist the session ID for future restarts
  setState(ORCHESTRATOR_SESSION_KEY, session.sessionId);
  console.log(`[max] Created orchestrator session ${session.sessionId.slice(0, 8)}…`);

  // Recover conversation context if available (session was lost, not first run)
  const recentHistory = getRecentConversation(10);
  if (recentHistory) {
    console.log(`[max] Injecting recent conversation context into new session`);
    try {
      await session.sendAndWait({
        prompt: `[System: Session recovered] Your previous session was lost. Here's the recent conversation for context — do NOT respond to these messages, just absorb the context silently:\n\n${recentHistory}\n\n(End of recovery context. Wait for the next real message.)`,
      }, 60_000);
    } catch (err) {
      console.log(`[max] Context recovery injection failed (non-fatal): ${err instanceof Error ? err.message : err}`);
    }
  }

  currentSessionModel = config.aiModel;
  return session;
}

export async function initOrchestrator(client: AIClient): Promise<void> {
  aiClient = client;
  const { mcpServers, skillDirectories } = getSessionConfig();

  // Validate configured model against available models
  try {
    const models = await client.listModels();
    const configured = config.aiModel;
    const isAvailable = models.some((m) => m.id === configured);
    if (!isAvailable) {
      const fallbackModel = getDefaultAiModel(config.aiProvider);
      console.log(`[max] ⚠️ Configured model '${configured}' is not available. Falling back to '${fallbackModel}'.`);
      config.aiModel = fallbackModel;
    }
  } catch (err) {
    console.log(`[max] Could not validate model (will use '${config.aiModel}' as-is): ${err instanceof Error ? err.message : err}`);
  }

  console.log(`[max] Loading ${Object.keys(mcpServers).length} MCP server(s): ${Object.keys(mcpServers).join(", ") || "(none)"}`);
  console.log(`[max] Skill directories: ${skillDirectories.join(", ") || "(none)"}`);
  console.log(`[max] Persistent session mode — conversation history maintained by SDK`);
  startHealthCheck();

  // Eagerly create/resume the orchestrator session
  try {
    await ensureOrchestratorSession();
  } catch (err) {
    console.error(`[max] Failed to create initial session (will retry on first message):`, err instanceof Error ? err.message : err);
  }
}

/** Send a prompt on the persistent session, return the response. */
async function executeOnSession(prompt: string, callback: MessageCallback): Promise<string> {
  const session = await ensureOrchestratorSession();
  currentCallback = callback;

  let accumulated = "";
  let toolCallExecuted = false;
  const unsubToolDone = session.on("tool.complete", () => {
    toolCallExecuted = true;
  });
  const unsubDelta = session.on("message.delta", (event) => {
    // After a tool call completes, ensure a line break separates the text blocks
    // so they don't visually run together in the TUI.
    if (toolCallExecuted && accumulated.length > 0 && !accumulated.endsWith("\n")) {
      accumulated += "\n";
    }
    toolCallExecuted = false;
    accumulated += event.data.deltaText;
    callback(accumulated, false);
  });

  try {
    const result = await session.sendAndWait({ prompt }, 300_000);
    const finalContent = result?.content || accumulated || "(No response)";
    return finalContent;
  } catch (err) {
    // If the session is broken, invalidate it so it's recreated on next attempt
    const msg = err instanceof Error ? err.message : String(err);
    if (/closed|destroy|disposed|invalid|expired|not found/i.test(msg)) {
      console.log(`[max] Session appears dead, will recreate: ${msg}`);
      orchestratorSession = undefined;
      currentSessionModel = undefined;
      deleteState(ORCHESTRATOR_SESSION_KEY);
    }
    throw err;
  } finally {
    unsubDelta();
    unsubToolDone();
    currentCallback = undefined;
  }
}

/** Process the message queue one at a time. */
async function processQueue(): Promise<void> {
  if (processing) {
    if (messageQueue.length > 0) {
      console.log(`[max] Message queued (${messageQueue.length} waiting — orchestrator is busy)`);
    }
    return;
  }
  processing = true;

  while (messageQueue.length > 0) {
    const item = messageQueue.shift()!;
    currentSourceChannel = item.sourceChannel;
    try {
      const workspaceContext = renderProfileContext("orchestrator");
      if (workspaceContext !== lastWorkspaceContext) {
        lastWorkspaceContext = workspaceContext;
        orchestratorSession = undefined;
        currentSessionModel = undefined;
        deleteState(ORCHESTRATOR_SESSION_KEY);
      }

      // Route the model before executing
      const routeResult = await resolveModel(item.prompt, currentSessionModel || config.aiModel, recentTiers, aiClient);
      if (routeResult.switched) {
        console.log(`[max] Auto: switching to ${routeResult.model} (${routeResult.overrideName || routeResult.tier})`);
        config.aiModel = routeResult.model;
        orchestratorSession = undefined;
        deleteState(ORCHESTRATOR_SESSION_KEY);
      }
      if (routeResult.tier) {
        recentTiers.push(routeResult.tier);
        if (recentTiers.length > 5) recentTiers = recentTiers.slice(-5);
      }
      lastRouteResult = routeResult;

      const result = await executeOnSession(item.prompt, item.callback);
      item.resolve(result);
    } catch (err) {
      item.reject(err);
    }
    currentSourceChannel = undefined;
  }

  processing = false;
}

function isRecoverableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /timeout|disconnect|connection|EPIPE|ECONNRESET|ECONNREFUSED|socket|closed|ENOENT|spawn|not found|expired|stale/i.test(msg);
}

export async function sendToOrchestrator(
  prompt: string,
  source: MessageSource,
  callback: MessageCallback
): Promise<void> {
  const sourceLabel =
    source.type === "telegram" ? "telegram" :
    source.type === "tui" ? "tui" :
    source.type === "heartbeat" ? "heartbeat" : "background";
  logMessage("in", sourceLabel, prompt);

  // Tag the prompt with its source channel
  const promptWithBootstrap = (source.type === "telegram" || source.type === "tui") && hasActiveBootstrap()
    ? wrapPromptForBootstrap(prompt)
    : prompt;

  const taggedPrompt = source.type === "background"
    ? promptWithBootstrap
    : `[via ${sourceLabel}] ${promptWithBootstrap}`;

  // Log role: background events are "system", user messages are "user"
  const logRole = source.type === "background" || source.type === "heartbeat" ? "system" : "user";

  // Determine the source channel for worker origin tracking
  const sourceChannel: ProactiveChannel | undefined =
    source.type === "telegram" ? "telegram" :
    source.type === "tui" ? "tui" :
    source.type === "heartbeat" ? config.heartbeatTarget : undefined;

  // Enqueue and process
  void (async () => {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const finalContent = await new Promise<string>((resolve, reject) => {
          messageQueue.push({ prompt: taggedPrompt, callback, sourceChannel, resolve, reject });
          processQueue();
        });
        // Deliver response to user FIRST, then log best-effort
        callback(finalContent, true);
        try { logMessage("out", sourceLabel, finalContent); } catch { /* best-effort */ }
        // Log both sides of the conversation after delivery
        try { logConversation(logRole, prompt, sourceLabel); } catch { /* best-effort */ }
        try { logConversation("assistant", finalContent, sourceLabel); } catch { /* best-effort */ }
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        // Don't retry cancelled messages
        if (/cancelled|abort/i.test(msg)) {
          return;
        }

        if (isRecoverableError(err) && attempt < MAX_RETRIES) {
          const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
          console.error(`[max] Recoverable error: ${msg}. Retry ${attempt + 1}/${MAX_RETRIES} after ${delay}ms…`);
          await sleep(delay);
          // Reset client before retry in case the connection is stale
          try { await ensureClient(); } catch { /* will fail again on next attempt */ }
          continue;
        }

        console.error(`[max] Error processing message: ${msg}`);
        callback(`Error: ${msg}`, true);
        return;
      }
    }
  })();
}

/** Cancel the in-flight message and drain the queue. */
export async function cancelCurrentMessage(): Promise<boolean> {
  // Drain any queued messages
  const drained = messageQueue.length;
  while (messageQueue.length > 0) {
    const item = messageQueue.shift()!;
    item.reject(new Error("Cancelled"));
  }

  // Abort the active session request
  if (orchestratorSession && currentCallback) {
    try {
      await orchestratorSession.abort();
      console.log(`[max] Aborted in-flight request`);
      return true;
    } catch (err) {
      console.error(`[max] Abort failed:`, err instanceof Error ? err.message : err);
    }
  }

  return drained > 0;
}

/** Start a fresh orchestrator session and clear the short recovery buffer. */
export async function resetOrchestratorSession(): Promise<void> {
  await cancelCurrentMessage();

  const activeSession = orchestratorSession;
  orchestratorSession = undefined;
  sessionCreatePromise = undefined;
  currentSessionModel = undefined;
  recentTiers = [];
  lastRouteResult = undefined;
  currentSourceChannel = undefined;

  deleteState(ORCHESTRATOR_SESSION_KEY);
  clearConversationLog();

  if (activeSession) {
    try {
      await activeSession.destroy();
    } catch (err) {
      console.log(`[max] Best-effort session destroy failed during reset: ${err instanceof Error ? err.message : err}`);
    }
  }
}

export function getWorkers(): Map<string, WorkerInfo> {
  return workers;
}
