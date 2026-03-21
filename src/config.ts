import { config as loadEnv } from "dotenv";
import { z } from "zod";
import { readFileSync, writeFileSync } from "fs";
import { ENV_PATH, ensureMaxHome } from "./paths.js";
import { normalizeAiProviderName, SUPPORTED_AI_PROVIDERS, type AIProviderName } from "./ai/types.js";

// Load from ~/.max/.env, fall back to cwd .env for dev
loadEnv({ path: ENV_PATH });
loadEnv(); // also check cwd for backwards compat

const configSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
  AUTHORIZED_USER_ID: z.string().min(1).optional(),
  API_PORT: z.string().optional(),
  AI_PROVIDER: z.string().optional(),
  AI_MODEL: z.string().optional(),
  CLASSIFIER_MODEL: z.string().optional(),
  COPILOT_MODEL: z.string().optional(),
  WORKER_TIMEOUT: z.string().optional(),
});

const raw = configSchema.parse(process.env);

const parsedUserId = raw.AUTHORIZED_USER_ID
  ? parseInt(raw.AUTHORIZED_USER_ID, 10)
  : undefined;
const parsedPort = parseInt(raw.API_PORT || "7777", 10);

if (parsedUserId !== undefined && (Number.isNaN(parsedUserId) || parsedUserId <= 0)) {
  throw new Error(`AUTHORIZED_USER_ID must be a positive integer, got: "${raw.AUTHORIZED_USER_ID}"`);
}
if (Number.isNaN(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
  throw new Error(`API_PORT must be 1-65535, got: "${raw.API_PORT}"`);
}

const DEFAULT_WORKER_TIMEOUT_MS = 600_000; // 10 minutes
const parsedWorkerTimeout = raw.WORKER_TIMEOUT
  ? Number(raw.WORKER_TIMEOUT)
  : DEFAULT_WORKER_TIMEOUT_MS;

if (!Number.isInteger(parsedWorkerTimeout) || parsedWorkerTimeout <= 0) {
  throw new Error(`WORKER_TIMEOUT must be a positive integer (ms), got: "${raw.WORKER_TIMEOUT}"`);
}

export const DEFAULT_MODEL = "claude-sonnet-4.6";
export const DEFAULT_AI_MODEL = DEFAULT_MODEL;
export const DEFAULT_PROVIDER: AIProviderName = "copilot";
export const DEFAULT_CLASSIFIER_MODEL = "gpt-4.1";
export const DEFAULT_MASTRA_MODEL = "openai/gpt-4.1";
export const DEFAULT_MASTRA_CLASSIFIER_MODEL = DEFAULT_MASTRA_MODEL;

export function getDefaultAiModel(provider: AIProviderName = DEFAULT_PROVIDER): string {
  return provider === "mastra" ? DEFAULT_MASTRA_MODEL : DEFAULT_AI_MODEL;
}

export function getDefaultClassifierModel(provider: AIProviderName = DEFAULT_PROVIDER): string {
  return provider === "mastra" ? DEFAULT_MASTRA_CLASSIFIER_MODEL : DEFAULT_CLASSIFIER_MODEL;
}

function persistLegacyProviderMigration(previousValue: string, nextValue: AIProviderName): void {
  const trimmedPreviousValue = previousValue.trim();
  if (!trimmedPreviousValue || trimmedPreviousValue === nextValue) {
    return;
  }

  try {
    const content = readFileSync(ENV_PATH, "utf-8");
    const lines = content.split("\n");
    let updated = false;
    const rewritten = lines.map((line) => {
      if (line.startsWith("AI_PROVIDER=")) {
        updated = true;
        return `AI_PROVIDER=${nextValue}`;
      }
      return line;
    });
    if (updated) {
      writeFileSync(ENV_PATH, rewritten.join("\n"));
    }
  } catch {
    // Best-effort migration only.
  }
}

const normalizedProvider = normalizeAiProviderName(raw.AI_PROVIDER);
const parsedProvider = normalizedProvider ?? DEFAULT_PROVIDER;
if (raw.AI_PROVIDER && !normalizedProvider) {
  throw new Error(
    `AI_PROVIDER must be one of: ${SUPPORTED_AI_PROVIDERS.join(", ")}. Got: "${raw.AI_PROVIDER}"`,
  );
}

if (raw.AI_PROVIDER?.trim().toLowerCase() === "maestra") {
  console.warn("[max] Detected legacy AI_PROVIDER=maestra. Migrating to AI_PROVIDER=mastra.");
  process.env.AI_PROVIDER = parsedProvider;
  persistLegacyProviderMigration(raw.AI_PROVIDER, parsedProvider);
}

let _aiModel = raw.AI_MODEL
  || (parsedProvider === "copilot" ? raw.COPILOT_MODEL : undefined)
  || getDefaultAiModel(parsedProvider);

export const config = {
  telegramBotToken: raw.TELEGRAM_BOT_TOKEN,
  authorizedUserId: parsedUserId,
  apiPort: parsedPort,
  workerTimeoutMs: parsedWorkerTimeout,
  aiProvider: parsedProvider,
  classifierModel: raw.CLASSIFIER_MODEL || getDefaultClassifierModel(parsedProvider),
  get aiModel(): string {
    return _aiModel;
  },
  set aiModel(model: string) {
    _aiModel = model;
  },
  get telegramEnabled(): boolean {
    return !!this.telegramBotToken && this.authorizedUserId !== undefined;
  },
  get selfEditEnabled(): boolean {
    return process.env.MAX_SELF_EDIT === "1";
  },
};

/** Update or append an env var in ~/.max/.env */
function persistEnvVar(key: string, value: string): void {
  ensureMaxHome();
  try {
    const content = readFileSync(ENV_PATH, "utf-8");
    const lines = content.split("\n");
    let found = false;
    const updated = lines.map((line) => {
      if (line.startsWith(`${key}=`)) {
        found = true;
        return `${key}=${value}`;
      }
      return line;
    });
    if (!found) updated.push(`${key}=${value}`);
    writeFileSync(ENV_PATH, updated.join("\n"));
  } catch {
    // File doesn't exist — create it
    writeFileSync(ENV_PATH, `${key}=${value}\n`);
  }
}

/** Persist the current model choice to ~/.max/.env */
export function persistModel(model: string): void {
  persistEnvVar("AI_MODEL", model);
}
