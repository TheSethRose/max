import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { basename, join, resolve } from "path";
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { LocalFilesystem, LocalSandbox, Workspace } from "@mastra/core/workspace";
import { z } from "zod";
import { config } from "../../config.js";
import type {
  AIClient,
  AIMessageResult,
  AIModelInfo,
  AIProviderRuntime,
  AISession,
  AISessionEventMap,
  AISessionOptions,
  AIToolDefinition,
} from "../../ai/types.js";

type SessionListener<E extends keyof AISessionEventMap> = (event: { data: AISessionEventMap[E] }) => void;

type StoredSessionMessage = {
  role: "user" | "assistant";
  content: string;
};

type StoredSessionState = {
  messages: StoredSessionMessage[];
};

const CURATED_MASTRA_MODELS: AIModelInfo[] = [
  { id: "openai/gpt-4.1", name: "OpenAI GPT-4.1", enabled: true, internalOnly: false },
  { id: "openai/gpt-5", name: "OpenAI GPT-5", enabled: true, internalOnly: false },
  { id: "anthropic/claude-4-5-sonnet", name: "Anthropic Claude 4.5 Sonnet", enabled: true, internalOnly: false },
  { id: "google/gemini-2.5-pro", name: "Google Gemini 2.5 Pro", enabled: true, internalOnly: false },
  { id: "minimax-coding-plan/MiniMax-M2.5", name: "MiniMax M2.5", enabled: true, internalOnly: false },
  { id: "xai/grok-4", name: "xAI Grok 4", enabled: true, internalOnly: false },
  { id: "openrouter/anthropic/claude-haiku-4-5", name: "OpenRouter Claude Haiku 4.5", enabled: true, internalOnly: false },
];

const COMMON_PROVIDER_API_KEYS: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  minimax: "MINIMAX_API_KEY",
  "minimax-coding-plan": "MINIMAX_API_KEY",
  "minimax-cn": "MINIMAX_API_KEY",
  "minimax-cn-coding-plan": "MINIMAX_API_KEY",
  xai: "XAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

type MastraStreamChunk = {
  type: string;
  payload?: {
    text?: string;
    error?: unknown;
  };
};

function ensureMastraModelConfigured(): void {
  const model = config.aiModel?.trim();
  if (!model) {
    throw new Error("AI_MODEL is required when AI_PROVIDER=mastra");
  }
  if (!model.includes("/")) {
    throw new Error(
      `Mastra models must use provider/model format (for example 'openai/gpt-4.1'). Got '${model}'.`,
    );
  }
}

export function inferMastraApiKeyEnv(model: string): string | undefined {
  const provider = model.split("/", 1)[0]?.toLowerCase();
  return provider ? COMMON_PROVIDER_API_KEYS[provider] : undefined;
}

export function listMastraModels(): AIModelInfo[] {
  const models = [...CURATED_MASTRA_MODELS];
  const configuredModel = config.aiModel?.trim();
  if (configuredModel && configuredModel.includes("/") && !models.some((model) => model.id === configuredModel)) {
    models.unshift({
      id: configuredModel,
      name: `${configuredModel} (configured)`,
      enabled: true,
      internalOnly: false,
    });
  }
  return models;
}

function ensureSessionDir(configDir?: string): string | undefined {
  if (!configDir) {
    return undefined;
  }
  const dir = join(configDir, "mastra");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function getSessionPath(configDir: string | undefined, sessionId: string): string | undefined {
  const dir = ensureSessionDir(configDir);
  return dir ? join(dir, `${sessionId}.json`) : undefined;
}

function buildWorkspace(options: AISessionOptions): Workspace | undefined {
  if (!options.workingDirectory) {
    return undefined;
  }

  const workingDirectory = resolve(options.workingDirectory);
  return new Workspace({
    id: `max-${basename(workingDirectory) || "workspace"}`,
    name: `Max Workspace (${basename(workingDirectory) || workingDirectory})`,
    filesystem: new LocalFilesystem({ basePath: workingDirectory }),
    sandbox: new LocalSandbox({ workingDirectory }),
    skills: options.skillDirectories?.map((directory) => resolve(directory)),
  });
}

function buildInstructions(options: AISessionOptions): string {
  const preamble = options.workingDirectory
    ? `You are a coding worker operating inside the local workspace at ${resolve(options.workingDirectory)}. Use your workspace tools when you need to inspect files, edit code, or run commands.`
    : "You are the primary Max orchestrator running on the Mastra runtime.";

  return options.systemMessage?.content
    ? `${preamble}\n\n${options.systemMessage.content}`
    : preamble;
}

function buildMastraTools(tools: readonly AIToolDefinition[] | undefined): Record<string, ReturnType<typeof createTool>> | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }

  return Object.fromEntries(
    tools.map((tool) => [
      tool.name,
      createTool({
        id: tool.name,
        description: tool.description,
        inputSchema: tool.parameters,
        outputSchema: z.object({ result: z.string() }),
        execute: async (inputData: unknown) => ({ result: await tool.handler(inputData) }),
      }),
    ]),
  );
}

function createAgent(options: AISessionOptions): any {
  const workspace = buildWorkspace(options);
  const tools = buildMastraTools(options.tools);
  const agentOptions: Record<string, unknown> = {
    id: randomUUID(),
    name: options.workingDirectory ? "Max Worker" : "Max Orchestrator",
    instructions: buildInstructions(options),
    model: options.model,
  };

  if (workspace) {
    agentOptions.workspace = workspace;
  }
  if (tools) {
    agentOptions.tools = tools;
  }

  return new Agent(agentOptions as any);
}

class MastraSession implements AISession {
  private readonly listeners: {
    [K in keyof AISessionEventMap]: Set<SessionListener<K>>;
  } = {
    "message.delta": new Set(),
    "tool.complete": new Set(),
  };

  private messages: StoredSessionMessage[];
  private abortController: AbortController | undefined;
  private destroyed = false;

  public constructor(
    public readonly sessionId: string,
    private readonly options: AISessionOptions,
    initialMessages: StoredSessionMessage[],
    private readonly storagePath?: string,
  ) {
    this.messages = initialMessages;
  }

  public async sendAndWait(
    request: { prompt: string },
    timeoutMs?: number,
  ): Promise<AIMessageResult | undefined> {
    if (this.destroyed) {
      throw new Error("Session has been destroyed");
    }

    const checkpoint = [...this.messages];
    const agent = createAgent(this.options);
    this.abortController = new AbortController();
    const timeout = timeoutMs ? setTimeout(() => this.abortController?.abort(), timeoutMs) : undefined;

    let finalText = "";
    let streamError: unknown;

    try {
      this.messages.push({ role: "user", content: request.prompt });
      this.persist();

      const stream = await agent.stream(this.messages as any, {
        abortSignal: this.abortController.signal,
        onFinish: (result: { text?: string }) => {
          finalText = result.text ?? "";
        },
        onError: ({ error }: { error: unknown }) => {
          streamError = error;
        },
      } as any);

      let accumulated = "";
      for await (const chunk of stream.fullStream as AsyncIterable<MastraStreamChunk>) {
        switch (chunk.type) {
          case "text-delta": {
            const delta = chunk.payload?.text ?? "";
            if (delta) {
              accumulated += delta;
              this.emit("message.delta", { deltaText: delta });
            }
            break;
          }
          case "tool-result":
            this.emit("tool.complete", {});
            break;
          case "error":
            streamError = chunk.payload?.error ?? new Error("Mastra stream error");
            break;
        }
      }

      if (streamError) {
        throw streamError;
      }
      if (this.abortController.signal.aborted) {
        throw new Error("Cancelled");
      }

      const content = finalText || accumulated;
      this.messages.push({ role: "assistant", content });
      this.persist();
      return { content };
    } catch (err) {
      this.messages = checkpoint;
      this.persist();
      if (this.abortController?.signal.aborted) {
        throw new Error("Cancelled");
      }
      throw err instanceof Error ? err : new Error(String(err));
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
      this.abortController = undefined;
    }
  }

  public async destroy(): Promise<void> {
    this.destroyed = true;
    this.abortController?.abort();
    if (this.storagePath && existsSync(this.storagePath)) {
      unlinkSync(this.storagePath);
    }
  }

  public async abort(): Promise<void> {
    this.abortController?.abort();
  }

  public on<E extends keyof AISessionEventMap>(
    event: E,
    handler: (event: { data: AISessionEventMap[E] }) => void,
  ): () => void {
    const listeners = this.listeners[event] as Set<SessionListener<E>>;
    listeners.add(handler);
    return () => {
      listeners.delete(handler);
    };
  }

  private emit<E extends keyof AISessionEventMap>(event: E, data: AISessionEventMap[E]): void {
    const listeners = this.listeners[event] as Set<SessionListener<E>>;
    for (const listener of listeners) {
      listener({ data });
    }
  }

  private persist(): void {
    if (!this.storagePath || this.destroyed) {
      return;
    }

    const state: StoredSessionState = { messages: this.messages };
    writeFileSync(this.storagePath, JSON.stringify(state, null, 2));
  }
}

class MastraClientAdapter implements AIClient {
  public getState(): string {
    return "connected";
  }

  public async listModels(): Promise<AIModelInfo[]> {
    ensureMastraModelConfigured();
    return listMastraModels();
  }

  public async createSession(options: AISessionOptions): Promise<AISession> {
    ensureMastraModelConfigured();
    const sessionId = randomUUID();
    const storagePath = getSessionPath(options.configDir, sessionId);
    return new MastraSession(sessionId, options, [], storagePath);
  }

  public async resumeSession(sessionId: string, options: AISessionOptions): Promise<AISession> {
    ensureMastraModelConfigured();
    const storagePath = getSessionPath(options.configDir, sessionId);
    if (!storagePath || !existsSync(storagePath)) {
      throw new Error(`No saved Mastra session '${sessionId}' found`);
    }

    const parsed = JSON.parse(readFileSync(storagePath, "utf-8")) as StoredSessionState;
    return new MastraSession(sessionId, options, parsed.messages || [], storagePath);
  }

  public async stop(): Promise<void> {
    // Stateless adapter.
  }
}

let adaptedClient: AIClient | undefined;

async function createClient(): Promise<AIClient> {
  adaptedClient = new MastraClientAdapter();
  return adaptedClient;
}

export const mastraRuntime: AIProviderRuntime = {
  provider: "mastra",

  async getClient(): Promise<AIClient> {
    if (!adaptedClient) {
      return createClient();
    }
    return adaptedClient;
  },

  async resetClient(): Promise<AIClient> {
    adaptedClient = undefined;
    return createClient();
  },

  async stopClient(): Promise<void> {
    adaptedClient = undefined;
  },
};