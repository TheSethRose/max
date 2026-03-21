import type { ZodType, ZodTypeAny } from "zod";

export const SUPPORTED_AI_PROVIDERS = ["copilot", "mastra"] as const;
const LEGACY_AI_PROVIDER_ALIASES = {
  maestra: "mastra",
} as const;

export type AIProviderName = (typeof SUPPORTED_AI_PROVIDERS)[number];

export function normalizeAiProviderName(provider: string | undefined): AIProviderName | undefined {
  const normalized = provider?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if (SUPPORTED_AI_PROVIDERS.includes(normalized as AIProviderName)) {
    return normalized as AIProviderName;
  }

  const legacyMatch = LEGACY_AI_PROVIDER_ALIASES[normalized as keyof typeof LEGACY_AI_PROVIDER_ALIASES];
  return legacyMatch;
}

export interface AIModelInfo {
  id: string;
  name: string;
  enabled: boolean;
  internalOnly: boolean;
  billingMultiplier?: number;
}

export interface AIMessageRequest {
  prompt: string;
}

export interface AIMessageResult {
  content: string;
}

export interface AISessionEventMap {
  "message.delta": { deltaText: string };
  "tool.complete": Record<string, never>;
}

interface AIToolAuthoringDefinition<TArgs> {
  name: string;
  description: string;
  parameters: ZodType<TArgs>;
  handler: (args: TArgs) => Promise<string>;
}

export interface AIToolDefinition {
  name: string;
  description: string;
  parameters: ZodTypeAny;
  handler: (args: unknown) => Promise<string>;
}

export function defineAiTool<TArgs>(tool: AIToolAuthoringDefinition<TArgs>): AIToolDefinition;
export function defineAiTool<TArgs>(
  name: string,
  tool: Omit<AIToolAuthoringDefinition<TArgs>, "name">,
): AIToolDefinition;
export function defineAiTool<TArgs>(
  toolOrName: string | AIToolAuthoringDefinition<TArgs>,
  tool?: Omit<AIToolAuthoringDefinition<TArgs>, "name">,
): AIToolDefinition {
  if (typeof toolOrName === "string") {
    if (!tool) {
      throw new Error(`Missing tool definition for '${toolOrName}'`);
    }
    return {
      name: toolOrName,
      description: tool.description,
      parameters: tool.parameters,
      handler: async (args: unknown) => tool.handler(args as TArgs),
    };
  }

  return {
    name: toolOrName.name,
    description: toolOrName.description,
    parameters: toolOrName.parameters,
    handler: async (args: unknown) => toolOrName.handler(args as TArgs),
  };
}

export interface AISessionPersistenceOptions {
  enabled: boolean;
  backgroundCompactionThreshold: number;
  bufferExhaustionThreshold: number;
}

export interface AISessionOptions {
  model: string;
  configDir?: string;
  workingDirectory?: string;
  streaming?: boolean;
  systemMessage?: { content: string };
  tools?: readonly AIToolDefinition[];
  mcpServers?: Record<string, unknown>;
  skillDirectories?: readonly string[];
  persistence?: AISessionPersistenceOptions;
}

export interface AISession {
  readonly sessionId: string;
  sendAndWait(request: AIMessageRequest, timeoutMs?: number): Promise<AIMessageResult | undefined>;
  destroy(): Promise<void>;
  abort(): Promise<void>;
  on<E extends keyof AISessionEventMap>(
    event: E,
    handler: (event: { data: AISessionEventMap[E] }) => void,
  ): () => void;
}

export interface AIClient {
  getState(): string;
  listModels(): Promise<AIModelInfo[]>;
  createSession(options: AISessionOptions): Promise<AISession>;
  resumeSession(sessionId: string, options: AISessionOptions): Promise<AISession>;
  stop(): Promise<void>;
}

export interface AIProviderRuntime {
  readonly provider: AIProviderName;
  getClient(): Promise<AIClient>;
  resetClient(): Promise<AIClient>;
  stopClient(): Promise<void>;
}