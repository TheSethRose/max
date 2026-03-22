import * as readline from "readline";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { ensureMaxHome, ENV_PATH, MAX_HOME } from "./paths.js";
import { getClient, stopClient } from "./ai/runtime.js";
import {
  DEFAULT_AI_MODEL,
  DEFAULT_CLASSIFIER_MODEL,
  DEFAULT_PROVIDER,
  DEFAULT_MASTRA_CLASSIFIER_MODEL,
  DEFAULT_MASTRA_MODEL,
  getDefaultAiModel,
  getDefaultClassifierModel,
} from "./config.js";
import { normalizeAiProviderName, SUPPORTED_AI_PROVIDERS, type AIProviderName } from "./ai/types.js";
import { inferMastraApiKeyEnv, listMastraModels } from "./providers/mastra/runtime.js";
import { ensureWorkspaceProfile, getWorkspaceProfileDir, getWorkspaceProfilePath } from "./workspace.js";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

const FALLBACK_COPILOT_MODELS = [
  { id: "claude-sonnet-4.6", label: "Claude Sonnet 4.6", desc: "Fast, great for most tasks" },
  { id: "gpt-5.1", label: "GPT-5.1", desc: "OpenAI's fast model" },
  { id: "gpt-4.1", label: "GPT-4.1", desc: "Free included model" },
];

const PROVIDER_METADATA: Record<AIProviderName, { label: string; desc: string; loginCommand: string }> = {
  copilot: {
    label: "GitHub Copilot",
    desc: "Default built-in provider using the Copilot CLI and SDK",
    loginCommand: "copilot login",
  },
  mastra: {
    label: "Mastra",
    desc: "Mastra agent runtime with provider/model strings and workspace-backed coding workers",
    loginCommand: "Set the required provider API key in ~/.max/.env",
  },
};

const PROVIDER_OPTIONS = SUPPORTED_AI_PROVIDERS.map((provider) => ({
  id: provider,
  label: PROVIDER_METADATA[provider].label,
  desc: PROVIDER_METADATA[provider].desc,
}));

async function fetchModels(
  provider: AIProviderName,
): Promise<{ id: string; label: string; desc: string }[]> {
  switch (provider) {
    case "copilot":
      try {
        const client = await getClient();
        const models = await client.listModels();
        return models
          .filter((m) => m.enabled && !m.internalOnly)
          .map((m) => {
            const mult = m.billingMultiplier;
            const desc =
              mult === 0 || mult === undefined ? "Included with Copilot" : `Premium (${mult}x)`;
            return { id: m.id, label: m.name, desc };
          });
      } catch {
        return [];
      } finally {
        try { await stopClient(); } catch { /* best-effort */ }
      }
    case "mastra":
      return listMastraModels().map((model) => ({
        id: model.id,
        label: model.name,
        desc: inferMastraApiKeyEnv(model.id)
          ? `Requires ${inferMastraApiKeyEnv(model.id)}`
          : "Provider/model string supported by Mastra",
      }));
  }
}

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

function isSensitiveConfigKey(name: string): boolean {
  return /(TOKEN|KEY|SECRET|PASSWORD)/i.test(name);
}

function obfuscateValue(value: string): string {
  if (!value) return value;

  const trimmed = value.trim();
  if (trimmed.length <= 4) {
    return "•".repeat(trimmed.length);
  }
  if (trimmed.length <= 8) {
    return `${trimmed.slice(0, 1)}${"•".repeat(trimmed.length - 2)}${trimmed.slice(-1)}`;
  }

  return `${trimmed.slice(0, 4)}${"•".repeat(Math.min(8, trimmed.length - 8))}${trimmed.slice(-4)}`;
}

function formatExistingValue(value: string | undefined, opts?: { keyName?: string; sensitive?: boolean }): string | undefined {
  if (!value?.trim()) {
    return undefined;
  }

  const sensitive = opts?.sensitive ?? (opts?.keyName ? isSensitiveConfigKey(opts.keyName) : false);
  return sensitive ? obfuscateValue(value) : value.trim();
}

function formatKeepCurrentHint(value: string | undefined, opts?: { keyName?: string; sensitive?: boolean }): string {
  const formatted = formatExistingValue(value, opts);
  return formatted ? ` ${DIM}(Enter to keep ${formatted})${RESET}` : "";
}

function formatCurrentStatus(value: string | undefined, opts?: { keyName?: string; sensitive?: boolean }): string | undefined {
  const formatted = formatExistingValue(value, opts);
  return formatted ? `${DIM}current: ${formatted}${RESET}` : undefined;
}

function formatConfiguredStatus(configured: boolean, label = "configured"): string {
  return configured ? `${DIM}current: ${label}${RESET}` : `${DIM}current: not configured${RESET}`;
}

async function askRequired(rl: readline.Interface, prompt: string): Promise<string> {
  while (true) {
    const answer = (await ask(rl, prompt)).trim();
    if (answer) return answer;
    console.log(`${YELLOW}  This field is required. Please enter a value.${RESET}`);
  }
}

async function askRequiredOrKeepCurrent(
  rl: readline.Interface,
  prompt: string,
  currentValue?: string,
  currentHint?: string,
): Promise<string> {
  while (true) {
    const answer = (await ask(rl, prompt)).trim();
    if (answer) return answer;
    if (currentValue) return currentValue;
    console.log(currentHint || `${YELLOW}  This field is required. Please enter a value.${RESET}`);
  }
}

function sanitizeEnvVarName(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
}

async function askYesNo(rl: readline.Interface, question: string, defaultYes = false): Promise<boolean> {
  const hint = defaultYes ? "(Y/n)" : "(y/N)";
  const answer = (await ask(rl, `${question} ${hint} `)).trim().toLowerCase();
  if (answer === "") return defaultYes;
  return answer === "y" || answer === "yes";
}

async function askPicker<T extends string>(
  rl: readline.Interface,
  label: string,
  options: { id: T; label: string; desc: string }[],
  defaultId: T,
): Promise<T> {
  console.log(`${BOLD}${label}${RESET}\n`);
  const defaultIdx = Math.max(0, options.findIndex((o) => o.id === defaultId));
  const defaultOption = options[defaultIdx];
  if (defaultOption) {
    console.log(`  ${DIM}Current: ${defaultOption.label}${RESET}`);
    console.log();
  }
  for (let i = 0; i < options.length; i++) {
    const marker = i === defaultIdx ? `${GREEN}▸${RESET}` : " ";
    const tag = i === defaultIdx ? ` ${DIM}(default)${RESET}` : "";
    console.log(`  ${marker} ${CYAN}${i + 1}${RESET}  ${options[i].label}${tag}`);
    console.log(`       ${DIM}${options[i].desc}${RESET}`);
  }
  console.log();
  const input = await ask(
    rl,
    `  Pick a number ${DIM}(1-${options.length}, Enter to keep ${defaultOption?.label || "current"})${RESET}: `,
  );
  const num = parseInt(input.trim(), 10);
  if (num >= 1 && num <= options.length) return options[num - 1].id;
  return options[defaultIdx].id;
}

async function main(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log(`
${BOLD}╔══════════════════════════════════════════╗
║           🤖  Max Setup                  ║
╚══════════════════════════════════════════╝${RESET}
`);

  console.log(`${DIM}Config directory: ${MAX_HOME}${RESET}\n`);

  ensureMaxHome();
  const workspaceStatus = ensureWorkspaceProfile();

  // Load existing values if any
  const existing: Record<string, string> = {};
  if (existsSync(ENV_PATH)) {
    for (const line of readFileSync(ENV_PATH, "utf-8").split("\n")) {
      const match = line.match(/^([A-Z_]+)=(.*)$/);
      if (match) existing[match[1]] = match[2];
    }
  }

  // ── What is Max ──────────────────────────────────────────
  console.log(`${BOLD}Meet Max${RESET}`);
  console.log(`Max is your personal AI assistant — an always-on daemon that runs on`);
  console.log(`your machine. Talk to him in plain English and he'll handle the rest.`);
  console.log();
  console.log(`${CYAN}What Max can do out of the box:${RESET}`);
  console.log(`  • Have conversations and answer questions`);
  console.log(`  • Spin up coding workers to code, debug, and run commands`);
  console.log(`  • Manage multiple background tasks simultaneously`);
  console.log(`  • See and attach to Copilot sessions on your machine when using Copilot`);
  console.log();
  console.log(`${CYAN}Skills — teach Max anything:${RESET}`);
  console.log(`  Max has a skill system that lets him learn new capabilities. There's`);
  console.log(`  an open source library of community skills he can install, or he can`);
  console.log(`  write his own from scratch. Just ask him:`);
  console.log();
  console.log(`  ${DIM}"Check my email"${RESET}        → Max researches how, writes a skill, does it`);
  console.log(`  ${DIM}"Turn off the lights"${RESET}   → Max finds the right CLI tool, learns it`);
  console.log(`  ${DIM}"Find me a skill for"${RESET}   → Max searches community skills and installs one`);
  console.log(`  ${DIM}"Learn how to use X"${RESET}    → Max proactively learns before you need it`);
  console.log();
  console.log(`  Skills are saved permanently — Max only needs to learn once.`);
  console.log();
  console.log(`${CYAN}How to talk to Max:${RESET}`);
  console.log(`  • ${BOLD}Terminal${RESET}  — ${CYAN}max tui${RESET} — always available, no setup needed`);
  console.log(`  • ${BOLD}Telegram${RESET} — control Max from your phone (optional, set up next)`);
  console.log();

  await ask(rl, `${DIM}Press Enter to continue...${RESET}`);
  console.log();

  // ── Telegram Setup ───────────────────────────────────────
  console.log(`${BOLD}━━━ Telegram Setup (optional) ━━━${RESET}\n`);
  console.log(`Telegram lets you talk to Max from your phone — send messages,`);
  console.log(`dispatch coding tasks, and get notified when background work finishes.`);
  console.log();

  let telegramToken = existing.TELEGRAM_BOT_TOKEN || "";
  let userId = existing.AUTHORIZED_USER_ID || "";

  const setupTelegramStatus = [
    formatCurrentStatus(telegramToken, { keyName: "TELEGRAM_BOT_TOKEN" }),
    formatCurrentStatus(userId, { keyName: "AUTHORIZED_USER_ID" }),
  ].filter((value): value is string => !!value).join(`${DIM}, ${RESET}`);
  const setupTelegram = await askYesNo(
    rl,
    `Would you like to set up Telegram?${setupTelegramStatus ? ` ${DIM}(${setupTelegramStatus})${RESET}` : ` ${formatConfiguredStatus(false)}`}`,
    !!telegramToken || !!userId,
  );

  if (setupTelegram) {
    // ── Step 1: Create bot ──
    console.log(`\n${BOLD}Step 1: Create a Telegram bot${RESET}\n`);
    console.log(`  1. Open Telegram and search for ${BOLD}@BotFather${RESET}`);
    console.log(`  2. Send ${CYAN}/newbot${RESET} and follow the prompts`);
    console.log(`  3. Copy the bot token (looks like ${DIM}123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11${RESET})`);
    console.log();

    const tokenInput = await askRequiredOrKeepCurrent(
      rl,
      `  Bot token${formatKeepCurrentHint(telegramToken, { keyName: "TELEGRAM_BOT_TOKEN" })}: `,
      telegramToken,
      `${YELLOW}  This field is required. Please enter a value.${RESET}`,
    );
    telegramToken = tokenInput;

    // ── Step 2: Lock it down ──
    console.log(`\n${BOLD}Step 2: Lock down your bot${RESET}\n`);
    console.log(`${YELLOW}  ⚠  IMPORTANT: Your bot is currently open to anyone on Telegram.${RESET}`);
    console.log(`  Max uses your Telegram user ID to ensure only YOU can control it.`);
    console.log(`  Without this, anyone who finds your bot could send it commands.`);
    console.log();
    console.log(`  To get your user ID:`);
    console.log(`  1. Search for ${BOLD}@userinfobot${RESET} on Telegram`);
    console.log(`  2. Send it any message`);
    console.log(`  3. It will reply with your user ID (a number like ${DIM}123456789${RESET})`);
    console.log();

    // Require user ID — cannot proceed without it
    while (true) {
      const userIdInput = await askRequiredOrKeepCurrent(
        rl,
        `  Your user ID${formatKeepCurrentHint(userId, { keyName: "AUTHORIZED_USER_ID" })}: `,
        userId,
        `${YELLOW}  That doesn't look like a valid user ID. It should be a positive number.${RESET}`,
      );
      const parsed = parseInt(userIdInput, 10);
      if (!Number.isNaN(parsed) && parsed > 0) {
        userId = userIdInput;
        break;
      }
      console.log(`${YELLOW}  That doesn't look like a valid user ID. It should be a positive number.${RESET}`);
    }

    console.log(`\n${GREEN}  ✓ Telegram locked down — only user ${userId} can control Max.${RESET}`);

    // ── Step 3: Disable group joins ──
    console.log(`\n${BOLD}Step 3: Disable group joins (recommended)${RESET}\n`);
    console.log(`  For extra security, prevent your bot from being added to groups:`);
    console.log(`  1. Go back to ${BOLD}@BotFather${RESET}`);
    console.log(`  2. Send ${CYAN}/mybots${RESET} → select your bot → ${CYAN}Bot Settings${RESET} → ${CYAN}Allow Groups?${RESET}`);
    console.log(`  3. Set to ${BOLD}Disable${RESET}`);
    console.log();

    await ask(rl, `  ${DIM}Press Enter when done (or skip)...${RESET}`);

  } else {
    console.log(`\n${DIM}  Skipping Telegram. You can always set it up later with: max setup${RESET}\n`);
  }

  // ── Google (gogcli) Setup ─────────────────────────────────
  console.log(`${BOLD}━━━ Google / Gmail Setup (optional) ━━━${RESET}\n`);
  console.log(`Max includes a Google skill that lets him read your email, manage`);
  console.log(`your calendar, access Drive, and more — using the ${BOLD}gog${RESET} CLI.`);
  console.log();

  const setupGoogle = await askYesNo(rl, "Would you like to set up Google services?");

  if (setupGoogle) {
    // ── Step 1: Install gog CLI ──
    console.log(`\n${BOLD}Step 1: Install the gog CLI${RESET}\n`);
    console.log(`  ${CYAN}brew install steipete/tap/gogcli${RESET}     ${DIM}(macOS/Linux with Homebrew)${RESET}`);
    console.log();

    await ask(rl, `  ${DIM}Press Enter when installed (or to skip)...${RESET}`);

    // ── Step 2: Create OAuth credentials ──
    console.log(`\n${BOLD}Step 2: Create OAuth credentials${RESET}\n`);
    console.log(`  You need a Google Cloud OAuth client to authenticate:`);
    console.log(`  1. Go to ${CYAN}https://console.cloud.google.com/apis/credentials${RESET}`);
    console.log(`  2. Create a project (if you don't have one)`);
    console.log(`  3. Enable the APIs you want (Gmail, Calendar, Drive, etc.)`);
    console.log(`  4. Configure the OAuth consent screen`);
    console.log(`  5. Create an OAuth client (type: ${BOLD}Desktop app${RESET})`);
    console.log(`  6. Download the JSON credentials file`);
    console.log();
    console.log(`  Then store the credentials:`);
    console.log(`  ${CYAN}gog auth credentials ~/Downloads/client_secret_....json${RESET}`);
    console.log();

    await ask(rl, `  ${DIM}Press Enter when done (or to skip)...${RESET}`);

    // ── Step 3: Authenticate ──
    console.log(`\n${BOLD}Step 3: Authenticate with your Google account${RESET}\n`);
    console.log(`  Run this command to authorize:`);
    console.log(`  ${CYAN}gog auth add your-email@gmail.com${RESET}`);
    console.log();
    console.log(`  This opens a browser for OAuth authorization. Once done, Max can`);
    console.log(`  access your Google services on your behalf.`);
    console.log();

    const googleEmail = await ask(
      rl,
      `  Google email ${DIM}(Enter to skip)${RESET}: `
    );

    if (googleEmail.trim()) {
      console.log(`\n  ${DIM}Run this now or later:${RESET}  ${CYAN}gog auth add ${googleEmail.trim()}${RESET}`);
      console.log(`  ${DIM}Check status anytime:${RESET}   ${CYAN}gog auth status${RESET}`);
    }

    console.log(`\n${GREEN}  ✓ Google skill is ready — authenticate with gog auth add when you're set.${RESET}\n`);
  } else {
    console.log(`\n${DIM}  Skipping Google. You can always set it up later with: max setup${RESET}\n`);
  }

  // ── Provider picker ──────────────────────────────────────
  console.log(`\n${BOLD}━━━ AI Provider ━━━${RESET}\n`);
  console.log(`Choose which AI runtime provider Max should use.`);
  console.log(`${DIM}The selected provider is written to ${ENV_PATH}.${RESET}\n`);

  const currentProvider = normalizeAiProviderName(existing.AI_PROVIDER) || DEFAULT_PROVIDER;
  const provider = await askPicker(rl, "Choose a provider:", PROVIDER_OPTIONS, currentProvider);
  const providerLabel = PROVIDER_METADATA[provider].label;

  console.log(`\n${GREEN}  ✓ Using ${providerLabel}${RESET}\n`);

  if (provider === "mastra") {
    console.log(`${BOLD}━━━ Mastra Configuration ━━━${RESET}\n`);
    console.log(`Mastra uses ${BOLD}provider/model${RESET} identifiers like ${CYAN}openai/gpt-4.1${RESET} or ${CYAN}anthropic/claude-4-5-sonnet${RESET}.`);
    console.log(`For coding workers, Mastra gets a local workspace with filesystem and command execution.`);
    console.log(`${DIM}You'll choose a model next, then Max will offer to save the matching provider API key env var.${RESET}\n`);
  }

  // ── Model picker ─────────────────────────────────────────
  console.log(`\n${BOLD}━━━ Default Model ━━━${RESET}\n`);
  console.log(`${DIM}Fetching available models from ${providerLabel}...${RESET}`);

  let models = await fetchModels(provider);
  if (models.length === 0) {
    console.log(`${YELLOW}  Could not fetch models for ${providerLabel}.${RESET}`);
    if (provider === "mastra") {
      console.log(`${DIM}  Enter a provider/model ID manually — you can switch anytime after setup.${RESET}\n`);
    } else {
      console.log(`${DIM}  Showing a curated list — you can switch anytime after setup.${RESET}\n`);
      models = FALLBACK_COPILOT_MODELS;
    }
  } else {
    console.log(`${GREEN}  ✓ Found ${models.length} models${RESET}\n`);
  }

  console.log(`${DIM}You can switch models anytime by telling Max "switch to gpt-4.1"${RESET}\n`);

  const defaultModel = getDefaultAiModel(provider);
  const currentModel = existing.AI_MODEL || existing.COPILOT_MODEL || defaultModel;
  let model: string;
  const useCustomMastraModel = provider === "mastra"
    ? await askYesNo(
        rl,
        "Would you like to enter a custom provider/model ID (for example minimax-coding-plan/MiniMax-M2.5)?",
        currentModel.includes("/") && !models.some((candidate) => candidate.id === currentModel),
      )
    : false;

  if (provider === "mastra" && useCustomMastraModel) {
    model = await askRequiredOrKeepCurrent(
      rl,
      `  Custom provider/model ID${currentModel ? ` ${DIM}(Enter to keep ${currentModel})${RESET}` : ""}: `,
      currentModel,
      `${YELLOW}  Enter a provider/model ID such as openai/gpt-4.1 or minimax-coding-plan/MiniMax-M2.5.${RESET}`,
    );
  } else {
    model = models.length > 0
      ? await askPicker(rl, "Choose a default model:", models, currentModel)
      : await askRequiredOrKeepCurrent(
          rl,
          `  Model ID${currentModel ? ` ${DIM}(Enter to keep ${currentModel})${RESET}` : ""}: `,
          currentModel,
        );
  }
  const modelLabel = models.find((m) => m.id === model)?.label || model;
  console.log(`\n${GREEN}  ✓ Using ${modelLabel}${RESET}\n`);

  let mastraApiKeyEnv: string | undefined;
  let mastraApiKeyValue: string | undefined;
  if (provider === "mastra") {
    mastraApiKeyEnv = inferMastraApiKeyEnv(model);
    if (mastraApiKeyEnv) {
      const currentApiKey = existing[mastraApiKeyEnv] || "";
      console.log(`${DIM}Mastra will use ${mastraApiKeyEnv} for ${model}.${RESET}`);
      mastraApiKeyValue = await askRequiredOrKeepCurrent(
        rl,
        `  ${mastraApiKeyEnv}${formatKeepCurrentHint(currentApiKey, { keyName: mastraApiKeyEnv })}: `,
        currentApiKey,
        `${YELLOW}  ${mastraApiKeyEnv} is required for the selected model.${RESET}`,
      );
      console.log(`\n${GREEN}  ✓ ${mastraApiKeyEnv} saved${RESET}\n`);
    } else {
      console.log(`${YELLOW}  Max couldn't infer the provider API key variable for '${model}'.${RESET}`);
      const customApiKeyEnvRaw = (await ask(
        rl,
        `  Custom API key env var ${DIM}(optional, e.g. MINIMAX_API_KEY)${RESET}: `,
      )).trim();
      const customApiKeyEnv = sanitizeEnvVarName(customApiKeyEnvRaw);
      if (customApiKeyEnv) {
        mastraApiKeyEnv = customApiKeyEnv;
        const currentApiKey = existing[mastraApiKeyEnv] || "";
        mastraApiKeyValue = await askRequiredOrKeepCurrent(
          rl,
          `  ${mastraApiKeyEnv}${formatKeepCurrentHint(currentApiKey, { keyName: mastraApiKeyEnv })}: `,
          currentApiKey,
          `${YELLOW}  ${mastraApiKeyEnv} is required for the selected model.${RESET}`,
        );
        console.log(`\n${GREEN}  ✓ ${mastraApiKeyEnv} saved${RESET}\n`);
      } else {
        console.log(`${DIM}  Make sure the required credentials are available in your environment before starting Max.${RESET}\n`);
      }
    }
  }

  // ── Write config ─────────────────────────────────────────
  const updatedEnv: Record<string, string> = { ...existing };
  delete updatedEnv.MAESTRA_BASE_URL;
  delete updatedEnv.MAESTRA_API_KEY;
  if (telegramToken) updatedEnv.TELEGRAM_BOT_TOKEN = telegramToken;
  if (userId) updatedEnv.AUTHORIZED_USER_ID = userId;
  updatedEnv.API_PORT = existing.API_PORT || "7777";
  updatedEnv.AI_PROVIDER = provider;
  updatedEnv.AI_MODEL = model;
  const existingClassifier = existing.CLASSIFIER_MODEL;
  updatedEnv.CLASSIFIER_MODEL = provider === "mastra"
    ? (existingClassifier && existingClassifier.includes("/") ? existingClassifier : model)
    : existingClassifier || DEFAULT_CLASSIFIER_MODEL;
  if (provider === "mastra" && mastraApiKeyEnv && mastraApiKeyValue) {
    updatedEnv[mastraApiKeyEnv] = mastraApiKeyValue;
  }

  const preferredOrder = [
    "TELEGRAM_BOT_TOKEN",
    "AUTHORIZED_USER_ID",
    "API_PORT",
    "AI_PROVIDER",
    "AI_MODEL",
    "CLASSIFIER_MODEL",
    "WORKER_TIMEOUT",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
    "MINIMAX_API_KEY",
    "XAI_API_KEY",
    "OPENROUTER_API_KEY",
    "COPILOT_MODEL",
  ];
  const lines = [
    ...preferredOrder.filter((key) => updatedEnv[key]).map((key) => `${key}=${updatedEnv[key]}`),
    ...Object.keys(updatedEnv)
      .filter((key) => !preferredOrder.includes(key) && updatedEnv[key])
      .sort()
      .map((key) => `${key}=${updatedEnv[key]}`),
  ];

  writeFileSync(ENV_PATH, lines.join("\n") + "\n");

  // ── Done ─────────────────────────────────────────────────
  console.log(`
${GREEN}${BOLD}✅ Max is ready!${RESET}
${DIM}Config saved to ${ENV_PATH}${RESET}
${DIM}Profile workspace: ${getWorkspaceProfileDir()}${RESET}
${DIM}Default profile markdown deployed from bundled templates during setup${RESET}
${workspaceStatus.bootstrapActive ? `${DIM}Bootstrap active: ${getWorkspaceProfilePath("BOOTSTRAP.md")}${RESET}` : ""}
${workspaceStatus.removedLocalBootstrapSource ? `${DIM}Local repo bootstrap removed after seeding (one-time setup)${RESET}` : ""}

${BOLD}Get started:${RESET}

  ${CYAN}1.${RESET} ${provider === "copilot"
    ? `Make sure ${providerLabel} is authenticated:\n     ${BOLD}${PROVIDER_METADATA[provider].loginCommand}${RESET}`
    : mastraApiKeyEnv
      ? `Confirm ${BOLD}${mastraApiKeyEnv}${RESET} is set ${DIM}(saved in ${ENV_PATH} if you entered it above)${RESET}`
      : `Confirm your chosen provider credentials are available to Mastra in the environment`}

  ${CYAN}2.${RESET} Start Max:
     ${BOLD}max start${RESET}

  ${CYAN}3.${RESET} ${setupTelegram ? "Open Telegram and message your bot!" : "Connect via terminal:"}
     ${BOLD}${setupTelegram ? "(message your bot on Telegram)" : "max tui"}${RESET}

  ${CYAN}4.${RESET} ${workspaceStatus.bootstrapActive
    ? `On your first chat, Max will run the one-time bootstrap in ${BOLD}${getWorkspaceProfilePath("BOOTSTRAP.md")}${RESET} to learn your preferences and refine the profile files.`
    : "If BOOTSTRAP.md was already completed, Max will use the existing profile files directly."}

${BOLD}Things to try:${RESET}

  ${DIM}"Start working on the auth bug in ~/dev/myapp"${RESET}
  ${DIM}"What sessions are running?"${RESET}
  ${DIM}"Find me a skill for checking Gmail"${RESET}
  ${DIM}"Learn how to control my smart lights"${RESET}
  ${DIM}"Switch to gpt-4.1"${RESET}
`);

  rl.close();
}

main().catch((err) => {
  console.error("Setup failed:", err);
  process.exit(1);
});
