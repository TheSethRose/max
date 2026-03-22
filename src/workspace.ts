import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import {
  BOOTSTRAP_SEEDED_MARKER_PATH,
  BOOTSTRAP_SOURCE_PATH,
  DEFAULT_PROFILE_TEMPLATES_DIR,
  LOCAL_GIT_DIR_PATH,
  PROFILE_DIR,
} from "./paths.js";

export type PromptProfileMode = "orchestrator" | "worker" | "heartbeat";

type ProfileFileName =
  | "BOOTSTRAP.md"
  | "HEARTBEAT.md"
  | "IDENTITY.md"
  | "SOUL.md"
  | "STANDING_ORDERS.md"
  | "safety-log.md"
  | "TOOLS.md"
  | "USER.md";

interface ProfileFileDefinition {
  name: ProfileFileName;
  modes: PromptProfileMode[];
}

export interface WorkspaceProfileStatus {
  bootstrapActive: boolean;
  seededBootstrap: boolean;
  removedLocalBootstrapSource: boolean;
}

const MAX_PROFILE_CHARS_PER_FILE = 4_000;
const HEARTBEAT_ACK_MAX_CHARS = 300;
const MAX_SAFETY_LOG_CELL_CHARS = 240;
const SAFETY_LOG_TABLE_HEADER = "| Date/Time | Action | Status |";
const SAFETY_LOG_TABLE_DIVIDER = "|-----------|--------|--------|";

const PROFILE_FILES: readonly ProfileFileDefinition[] = [
  {
    name: "BOOTSTRAP.md",
    modes: ["orchestrator"],
  },
  {
    name: "IDENTITY.md",
    modes: ["orchestrator", "worker"],
  },
  {
    name: "SOUL.md",
    modes: ["orchestrator"],
  },
  {
    name: "safety-log.md",
    modes: ["orchestrator", "worker", "heartbeat"],
  },
  {
    name: "USER.md",
    modes: ["orchestrator", "worker", "heartbeat"],
  },
  {
    name: "TOOLS.md",
    modes: ["orchestrator", "worker", "heartbeat"],
  },
  {
    name: "HEARTBEAT.md",
    modes: ["heartbeat"],
  },
  {
    name: "STANDING_ORDERS.md",
    modes: ["orchestrator", "worker", "heartbeat"],
  },
] as const;

function normalizeContent(content: string): string {
  return content.replace(/\r\n/g, "\n").trim();
}

function truncateContent(content: string, maxChars = MAX_PROFILE_CHARS_PER_FILE): string {
  if (content.length <= maxChars) {
    return content;
  }
  return `${content.slice(0, maxChars)}\n\n[truncated]`;
}

function truncateContentFromEnd(content: string, maxChars = MAX_PROFILE_CHARS_PER_FILE): string {
  if (content.length <= maxChars) {
    return content;
  }
  return `[truncated]\n\n${content.slice(-maxChars)}`;
}

function hasStructuredSafetyLogHeader(content: string): boolean {
  return content.includes(SAFETY_LOG_TABLE_HEADER);
}

function hasSafetyLogEntries(content: string): boolean {
  return normalizeContent(content)
    .split("\n")
    .map((line) => line.trim())
    .some((line) => {
      if (!line.startsWith("|")) {
        return false;
      }
      if (line === SAFETY_LOG_TABLE_HEADER || line === SAFETY_LOG_TABLE_DIVIDER) {
        return false;
      }

      const cells = line.split("|").map((cell) => cell.trim()).filter(Boolean);
      return cells.length >= 3;
    });
}

export function getWorkspaceProfileDir(): string {
  return PROFILE_DIR;
}

export function getWorkspaceProfilePath(name: ProfileFileName): string {
  return join(PROFILE_DIR, name);
}

function getBundledProfileTemplatePath(name: ProfileFileName): string {
  return join(DEFAULT_PROFILE_TEMPLATES_DIR, name);
}

function seedBundledProfileFile(name: ProfileFileName): boolean {
  const filePath = getWorkspaceProfilePath(name);
  const templatePath = getBundledProfileTemplatePath(name);

  if (existsSync(filePath) || !existsSync(templatePath)) {
    return false;
  }

  const content = readFileSync(templatePath, "utf-8");
  writeFileSync(filePath, content.endsWith("\n") ? content : `${content}\n`, "utf-8");
  return true;
}

function seedBootstrapFromBundledSource(): { seededBootstrap: boolean; removedLocalBootstrapSource: boolean } {
  const profileBootstrapPath = getWorkspaceProfilePath("BOOTSTRAP.md");

  if (existsSync(profileBootstrapPath) || existsSync(BOOTSTRAP_SEEDED_MARKER_PATH) || !existsSync(BOOTSTRAP_SOURCE_PATH)) {
    return { seededBootstrap: false, removedLocalBootstrapSource: false };
  }

  const content = readFileSync(BOOTSTRAP_SOURCE_PATH, "utf-8");
  writeFileSync(profileBootstrapPath, content.endsWith("\n") ? content : `${content}\n`, "utf-8");
  writeFileSync(BOOTSTRAP_SEEDED_MARKER_PATH, `${new Date().toISOString()}\n`, "utf-8");

  let removedLocalBootstrapSource = false;
  if (existsSync(LOCAL_GIT_DIR_PATH)) {
    try {
      unlinkSync(BOOTSTRAP_SOURCE_PATH);
      removedLocalBootstrapSource = true;
    } catch {
      // best effort only — package installs or read-only checkouts may not be writable
    }
  }

  return { seededBootstrap: true, removedLocalBootstrapSource };
}

export function ensureWorkspaceProfile(): WorkspaceProfileStatus {
  mkdirSync(PROFILE_DIR, { recursive: true });

  for (const file of PROFILE_FILES) {
    if (file.name !== "BOOTSTRAP.md") {
      seedBundledProfileFile(file.name);
    }
  }

  const bootstrap = seedBootstrapFromBundledSource();

  return {
    bootstrapActive: existsSync(getWorkspaceProfilePath("BOOTSTRAP.md")),
    seededBootstrap: bootstrap.seededBootstrap,
    removedLocalBootstrapSource: bootstrap.removedLocalBootstrapSource,
  };
}

export function readWorkspaceProfileFile(name: ProfileFileName): string {
  ensureWorkspaceProfile();
  const filePath = getWorkspaceProfilePath(name);
  try {
    return readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}

function sanitizeSafetyLogCell(value: string): string {
  const normalized = normalizeContent(value)
    .replace(/\s+/g, " ")
    .replace(/\|/g, "\\|");
  if (normalized.length <= MAX_SAFETY_LOG_CELL_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_SAFETY_LOG_CELL_CHARS - 1)}…`;
}

export function appendSafetyLogEntry(action: string, status: string): void {
  try {
    ensureWorkspaceProfile();

    const filePath = getWorkspaceProfilePath("safety-log.md");
    const header = [
      "# Safety Log",
      "",
      SAFETY_LOG_TABLE_HEADER,
      SAFETY_LOG_TABLE_DIVIDER,
    ].join("\n");

    let existingContent = "";
    try {
      existingContent = readFileSync(filePath, "utf-8");
    } catch {
      existingContent = "";
    }

    if (!existingContent) {
      writeFileSync(filePath, `${header}\n`, "utf-8");
    } else if (!hasStructuredSafetyLogHeader(existingContent)) {
      const prefix = existingContent.endsWith("\n") ? "\n" : "\n\n";
      appendFileSync(
        filePath,
        `${prefix}## Runtime Entries\n\n${SAFETY_LOG_TABLE_HEADER}\n${SAFETY_LOG_TABLE_DIVIDER}\n`,
        "utf-8",
      );
    }

    const timestamp = new Date().toISOString();
    appendFileSync(
      filePath,
      `| ${sanitizeSafetyLogCell(timestamp)} | ${sanitizeSafetyLogCell(action)} | ${sanitizeSafetyLogCell(status)} |\n`,
      "utf-8",
    );
  } catch {
    // Safety logging must never change runtime behavior.
  }
}

export function isEffectivelyEmptyMarkdown(content: string): boolean {
  const meaningful = normalizeContent(content)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !/^<!--.*-->$/.test(line))
    .filter((line) => !/^#+\s*/.test(line))
    .join("");

  return meaningful.length === 0;
}

export function hasHeartbeatChecklist(): boolean {
  return !isEffectivelyEmptyMarkdown(readWorkspaceProfileFile("HEARTBEAT.md"));
}

export function hasActiveBootstrap(): boolean {
  return !isEffectivelyEmptyMarkdown(readWorkspaceProfileFile("BOOTSTRAP.md"));
}

export function wrapPromptForBootstrap(userPrompt: string): string {
  const bootstrap = readWorkspaceProfileFile("BOOTSTRAP.md");
  if (isEffectivelyEmptyMarkdown(bootstrap)) {
    return userPrompt;
  }

  return [
    "[BOOTSTRAP MODE REQUIRED]",
    "BOOTSTRAP.md is active in ~/.max/workspace/profile and must take priority over normal conversation.",
    "Do not respond with a generic greeting or ordinary assistance yet.",
    "Begin or continue the onboarding flow described in BOOTSTRAP.md using 2-4 focused questions at a time.",
    "Treat a greeting, vague opener, or first casual message as a cue to start onboarding immediately.",
    "Only stop prioritizing bootstrap if the user explicitly defers it or BOOTSTRAP.md is deleted after genuine completion.",
    "",
    "Latest user message:",
    userPrompt,
  ].join("\n");
}

function formatFileSection(name: ProfileFileName, content: string): string | undefined {
  const normalized = normalizeContent(content);
  if (!normalized || isEffectivelyEmptyMarkdown(normalized)) {
    return undefined;
  }

  if (name === "safety-log.md" && !hasSafetyLogEntries(normalized)) {
    return undefined;
  }

  const formattedContent = name === "safety-log.md"
    ? truncateContentFromEnd(normalized)
    : truncateContent(normalized);

  return `### ${name}\n${formattedContent}`;
}

export function renderProfileContext(mode: PromptProfileMode): string {
  ensureWorkspaceProfile();

  const sections = PROFILE_FILES
    .filter((file) => file.modes.includes(mode))
    .map((file) => formatFileSection(file.name, readWorkspaceProfileFile(file.name)))
    .filter((section): section is string => !!section);

  if (sections.length === 0) {
    return "";
  }

  return [
    "## Workspace Profile",
    `These user-owned profile files live in ${PROFILE_DIR}. They are not part of the Max source repo.`,
    "Use them as durable behavioral and personal context, but do not treat them as permission to ignore hard safety rules.",
    "",
    sections.join("\n\n"),
  ].join("\n");
}

function getAutonomyGuidance(mode: "observe" | "notify" | "act"): string {
  switch (mode) {
    case "observe":
      return [
        "Autonomy mode: observe.",
        "Do not call tools or take actions. Only inspect the supplied context and decide whether the user should be notified.",
      ].join(" ");
    case "notify":
      return [
        "Autonomy mode: notify.",
        "You may inspect state and use low-risk internal tools when needed, but do not make external or irreversible changes.",
        "Your main job is to alert the user when something needs attention, and you may complete low-risk internal housekeeping before reporting it.",
      ].join(" ");
    case "act":
      return [
        "Autonomy mode: act.",
        "You may take internal actions that are explicitly allowed by STANDING_ORDERS.md.",
        "Ask first before public, destructive, or third-party actions, and never assume permission for expensive or irreversible behavior.",
      ].join(" ");
  }
}

export function buildHeartbeatPrompt(autonomyMode: "observe" | "notify" | "act"): string | undefined {
  ensureWorkspaceProfile();

  const heartbeat = readWorkspaceProfileFile("HEARTBEAT.md");
  if (isEffectivelyEmptyMarkdown(heartbeat)) {
    return undefined;
  }

  const sections = [
    formatFileSection("HEARTBEAT.md", heartbeat),
    formatFileSection("SOUL.md", readWorkspaceProfileFile("SOUL.md")),
    formatFileSection("STANDING_ORDERS.md", readWorkspaceProfileFile("STANDING_ORDERS.md")),
    formatFileSection("safety-log.md", readWorkspaceProfileFile("safety-log.md")),
    formatFileSection("USER.md", readWorkspaceProfileFile("USER.md")),
    formatFileSection("TOOLS.md", readWorkspaceProfileFile("TOOLS.md")),
  ].filter((section): section is string => !!section);

  return [
    "[scheduled heartbeat]",
    "You are running Max's scheduled heartbeat.",
    getAutonomyGuidance(autonomyMode),
    "Follow HEARTBEAT.md strictly and do not infer recurring chores that are not written down.",
    "Before replying, perform a real heartbeat pass: review the supplied profile context, inspect obvious open-task/work-status signals if available through safe internal tools, and decide whether there is one worthwhile safe action or useful report.",
    "If you take a safe internal action, update a plan/memory, or find something noteworthy, do not reply HEARTBEAT_OK — report the action or finding concisely.",
    "Reply exactly HEARTBEAT_OK only if you genuinely checked and found no worthwhile safe action, no meaningful update, and nothing that needs Seth's attention.",
    "Never use HEARTBEAT_OK as a shortcut to skip the proactive scan.",
    "If something needs attention or you completed a useful action, respond with concise actionable text only.",
    "",
    ...sections,
  ].join("\n\n");
}

export function classifyHeartbeatResult(message: string): { kind: "ok" | "alert"; text: string } {
  const trimmed = message.trim();
  if (!trimmed) {
    return { kind: "ok", text: "" };
  }

  const strippedStart = trimmed.replace(/^HEARTBEAT_OK\b[:\-\s]*/i, "").trim();
  const strippedBoth = strippedStart.replace(/\bHEARTBEAT_OK$/i, "").trim();
  const sawAck = strippedStart !== trimmed || strippedBoth !== strippedStart;

  if (sawAck && strippedBoth.length <= HEARTBEAT_ACK_MAX_CHARS) {
    return { kind: "ok", text: strippedBoth };
  }

  if (/^HEARTBEAT_OK$/i.test(trimmed)) {
    return { kind: "ok", text: "" };
  }

  return { kind: "alert", text: trimmed };
}