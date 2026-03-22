import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import {
  BOOTSTRAP_SEEDED_MARKER_PATH,
  BOOTSTRAP_SOURCE_PATH,
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
  | "TOOLS.md"
  | "USER.md";

interface ProfileFileDefinition {
  name: ProfileFileName;
  modes: PromptProfileMode[];
  template: string;
}

export interface WorkspaceProfileStatus {
  bootstrapActive: boolean;
  seededBootstrap: boolean;
  removedLocalBootstrapSource: boolean;
}

const MAX_PROFILE_CHARS_PER_FILE = 4_000;
const HEARTBEAT_ACK_MAX_CHARS = 300;

const PROFILE_FILES: readonly ProfileFileDefinition[] = [
  {
    name: "IDENTITY.md",
    modes: ["orchestrator", "worker"],
    template: `# Identity

Name: Max
Role: Personal AI assistant for development and operations
Vibe: Warm, direct, competent, lightly witty
Signature: 🤖

Notes:
- Keep this brief and durable.
- This file should describe who Max is, not task-specific instructions.
`,
  },
  {
    name: "SOUL.md",
    modes: ["orchestrator"],
    template: `# Soul

Behavior guidelines:

- Be helpful without filler.
- Prefer competence over theatrics.
- Read context before asking obvious questions.
- Be cautious with external actions and bold with internal analysis.
- Tell the user when an important profile rule changes.

Boundaries:

- Do not impersonate the user.
- Ask before public, external, destructive, or expensive actions unless standing orders explicitly allow them.
- Keep private data private.
`,
  },
  {
    name: "USER.md",
    modes: ["orchestrator", "worker", "heartbeat"],
    template: `# User

Keep user-specific identity, timezone, and working preferences here instead of hard-coding them in Max source.

Name:
Preferred name:
Timezone:
Pronouns:

Current context:

-

Preferences:

-
`,
  },
  {
    name: "TOOLS.md",
    modes: ["orchestrator", "worker", "heartbeat"],
    template: `# Tool notes

Use this file for machine-specific details that should not live in source code.

Examples:

- Preferred directories
- Hostnames or local aliases
- Safe default channels
- Notes about installed CLIs or services
- Human-readable descriptions of local setup
`,
  },
  {
    name: "HEARTBEAT.md",
    modes: ["heartbeat"],
    template: `# Heartbeat checklist

<!--
Keep this file tiny. Add short recurring checks below when you want scheduled awareness.
If this file only contains headings/comments, Max will skip heartbeat runs.
-->
`,
  },
  {
    name: "STANDING_ORDERS.md",
    modes: ["orchestrator", "worker", "heartbeat"],
    template: `# Standing orders

Autonomy mode:

- observe | notify | act

Allowed without asking:

- summarize finished background work
- flag urgent follow-ups

Ask first before:

- messaging third parties
- public posts or emails
- destructive changes
- changing persistent config or installing new dependencies

Never do autonomously:

- irreversible external actions
- anything that spends money
- anything that could expose secrets or private data
`,
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

export function getWorkspaceProfileDir(): string {
  return PROFILE_DIR;
}

export function getWorkspaceProfilePath(name: ProfileFileName): string {
  return join(PROFILE_DIR, name);
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
    const filePath = getWorkspaceProfilePath(file.name);
    if (!existsSync(filePath)) {
      writeFileSync(filePath, `${file.template.trimEnd()}\n`, "utf-8");
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

function formatFileSection(name: ProfileFileName, content: string): string | undefined {
  const normalized = normalizeContent(content);
  if (!normalized || isEffectivelyEmptyMarkdown(normalized)) {
    return undefined;
  }

  return `### ${name}\n${truncateContent(normalized)}`;
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
        "Your main job is to alert the user when something needs attention.",
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
    formatFileSection("STANDING_ORDERS.md", readWorkspaceProfileFile("STANDING_ORDERS.md")),
    formatFileSection("USER.md", readWorkspaceProfileFile("USER.md")),
    formatFileSection("TOOLS.md", readWorkspaceProfileFile("TOOLS.md")),
  ].filter((section): section is string => !!section);

  return [
    "[scheduled heartbeat]",
    "You are running Max's scheduled heartbeat.",
    getAutonomyGuidance(autonomyMode),
    "Follow HEARTBEAT.md strictly and do not infer recurring chores that are not written down.",
    "If nothing needs attention, reply exactly HEARTBEAT_OK.",
    "If something needs attention, respond with concise actionable text only.",
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