import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { basename, join, resolve } from "path";
import { pathToFileURL } from "url";
import { Agent } from "@mastra/core/agent";
import { createTool, type Tool } from "@mastra/core/tools";
import { MCPClient, type LogHandler, type MastraMCPServerDefinition, type Root } from "@mastra/mcp";
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

type MastraToolMap = Record<string, Tool<any, any, any, any>>;

type PreparedMastraSession = {
  tools?: MastraToolMap;
  mcpClient?: MCPClient;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const values = value.filter((entry): entry is string => typeof entry === "string");
  return values.length > 0 ? values : undefined;
}

function toStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function mergeToolMaps(...toolMaps: Array<MastraToolMap | undefined>): MastraToolMap | undefined {
  const merged = Object.assign({}, ...toolMaps.filter((toolMap): toolMap is MastraToolMap => !!toolMap));
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function buildWorkspaceRoots(workingDirectory: string | undefined): Root[] | undefined {
  if (!workingDirectory) {
    return undefined;
  }

  const resolvedDirectory = resolve(workingDirectory);
  return [
    {
      uri: pathToFileURL(resolvedDirectory).toString(),
      name: basename(resolvedDirectory) || resolvedDirectory,
    },
  ];
}

function normalizeMcpServers(options: AISessionOptions): Record<string, MastraMCPServerDefinition> | undefined {
  if (!options.mcpServers) {
    return undefined;
  }

  const defaultRoots = buildWorkspaceRoots(options.workingDirectory);
  const normalizedEntries: Array<[string, MastraMCPServerDefinition]> = [];

  for (const [serverName, rawConfig] of Object.entries(options.mcpServers)) {
    if (!isRecord(rawConfig)) {
      continue;
    }

    const timeout = typeof rawConfig.timeout === "number" ? rawConfig.timeout : undefined;
    const logger: LogHandler | undefined = typeof rawConfig.logger === "function"
      ? rawConfig.logger as LogHandler
      : typeof rawConfig.log === "function"
        ? rawConfig.log as LogHandler
        : undefined;
    const roots = Array.isArray(rawConfig.roots) ? rawConfig.roots as Root[] : defaultRoots;
    const baseConfig = {
      timeout,
      logger,
      roots,
      enableServerLogs: typeof rawConfig.enableServerLogs === "boolean" ? rawConfig.enableServerLogs : undefined,
      enableProgressTracking: typeof rawConfig.enableProgressTracking === "boolean"
        ? rawConfig.enableProgressTracking
        : undefined,
      capabilities: isRecord(rawConfig.capabilities) ? rawConfig.capabilities : undefined,
    };

    if (typeof rawConfig.command === "string") {
      normalizedEntries.push([serverName, {
        ...baseConfig,
        command: rawConfig.command,
        args: toStringArray(rawConfig.args),
        env: toStringRecord(rawConfig.env),
        cwd: typeof rawConfig.cwd === "string"
          ? resolve(rawConfig.cwd)
          : options.workingDirectory
            ? resolve(options.workingDirectory)
            : undefined,
      }]);
      continue;
    }

    const rawUrl = rawConfig.url;
    if (typeof rawUrl === "string" || rawUrl instanceof URL) {
      const requestInit = isRecord(rawConfig.requestInit)
        ? rawConfig.requestInit as RequestInit
        : isRecord(rawConfig.headers)
          ? { headers: rawConfig.headers as HeadersInit }
          : undefined;

      try {
        normalizedEntries.push([serverName, {
          ...baseConfig,
          url: rawUrl instanceof URL ? rawUrl : new URL(rawUrl),
          requestInit,
          connectTimeout: typeof rawConfig.connectTimeout === "number" ? rawConfig.connectTimeout : undefined,
          sessionId: typeof rawConfig.sessionId === "string" ? rawConfig.sessionId : undefined,
        }]);
      } catch (error) {
        console.warn(
          `[max] Skipping invalid MCP server '${serverName}' for Mastra: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      continue;
    }

    console.warn(`[max] Skipping MCP server '${serverName}' for Mastra: unsupported config shape`);
  }

  return normalizedEntries.length > 0 ? Object.fromEntries(normalizedEntries) : undefined;
}

function buildMastraTools(tools: readonly AIToolDefinition[] | undefined): MastraToolMap | undefined {
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

async function prepareMastraSession(options: AISessionOptions, sessionId: string): Promise<PreparedMastraSession> {
  const localTools = buildMastraTools(options.tools);
  const mcpServers = normalizeMcpServers(options);

  if (!mcpServers) {
    return { tools: localTools };
  }

  const mcpClient = new MCPClient({
    id: `max-${sessionId}`,
    servers: mcpServers,
    timeout: 30_000,
  });

  try {
    const mcpTools = await mcpClient.listTools();
    return {
      tools: mergeToolMaps(localTools, mcpTools),
      mcpClient,
    };
  } catch (error) {
    await mcpClient.disconnect().catch(() => undefined);
    console.warn(
      `[max] Failed to initialize MCP tools for Mastra session ${sessionId.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { tools: localTools };
  }
}

function createAgent(options: AISessionOptions, tools: MastraToolMap | undefined): any {
  const workspace = buildWorkspace(options);
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
    private readonly tools: MastraToolMap | undefined,
    private readonly mcpClient: MCPClient | undefined,
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
    const agent = createAgent(this.options, this.tools);
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
    await this.mcpClient?.disconnect().catch(() => undefined);
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
    const preparedSession = await prepareMastraSession(options, sessionId);
    return new MastraSession(
      sessionId,
      options,
      [],
      preparedSession.tools,
      preparedSession.mcpClient,
      storagePath,
    );
  }

  public async resumeSession(sessionId: string, options: AISessionOptions): Promise<AISession> {
    ensureMastraModelConfigured();
    const storagePath = getSessionPath(options.configDir, sessionId);
    if (!storagePath || !existsSync(storagePath)) {
      throw new Error(`No saved Mastra session '${sessionId}' found`);
    }

    const parsed = JSON.parse(readFileSync(storagePath, "utf-8")) as StoredSessionState;
    const preparedSession = await prepareMastraSession(options, sessionId);
    return new MastraSession(
      sessionId,
      options,
      parsed.messages || [],
      preparedSession.tools,
      preparedSession.mcpClient,
      storagePath,
    );
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