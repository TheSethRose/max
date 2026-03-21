import {
  approveAll,
  CopilotClient,
  defineTool,
  type CopilotSession,
} from "@github/copilot-sdk";
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

function mapModelInfo(model: Awaited<ReturnType<CopilotClient["listModels"]>>[number]): AIModelInfo {
  return {
    id: model.id,
    name: model.name,
    enabled: model.policy?.state === "enabled",
    internalOnly: model.name.includes("(Internal only)"),
    billingMultiplier: model.billing?.multiplier,
  };
}

function toCopilotTools(
  tools: readonly AIToolDefinition[] | undefined,
): Parameters<CopilotClient["createSession"]>[0]["tools"] {
  if (!tools || tools.length === 0) {
    return undefined;
  }

  return tools.map((tool) =>
    defineTool(tool.name, {
      description: tool.description,
      parameters: tool.parameters,
      handler: tool.handler,
    }),
  );
}

function mapSessionOptions(
  options: AISessionOptions,
): Parameters<CopilotClient["createSession"]>[0] {
  return {
    model: options.model,
    configDir: options.configDir,
    workingDirectory: options.workingDirectory,
    streaming: options.streaming,
    systemMessage: options.systemMessage,
    tools: toCopilotTools(options.tools),
    mcpServers: options.mcpServers as Parameters<CopilotClient["createSession"]>[0]["mcpServers"],
    skillDirectories: options.skillDirectories ? [...options.skillDirectories] : undefined,
    onPermissionRequest: approveAll,
    infiniteSessions: options.persistence
      ? {
          enabled: options.persistence.enabled,
          backgroundCompactionThreshold: options.persistence.backgroundCompactionThreshold,
          bufferExhaustionThreshold: options.persistence.bufferExhaustionThreshold,
        }
      : undefined,
  };
}

class CopilotSessionAdapter implements AISession {
  public constructor(private readonly session: CopilotSession) {}

  public get sessionId(): string {
    return this.session.sessionId;
  }

  public async sendAndWait(
    request: { prompt: string },
    timeoutMs?: number,
  ): Promise<AIMessageResult | undefined> {
    const result = await this.session.sendAndWait({ prompt: request.prompt }, timeoutMs);
    const content = result?.data?.content;
    return content === undefined ? undefined : { content };
  }

  public async destroy(): Promise<void> {
    await this.session.destroy();
  }

  public async abort(): Promise<void> {
    await this.session.abort();
  }

  public on<E extends keyof AISessionEventMap>(
    event: E,
    handler: (event: { data: AISessionEventMap[E] }) => void,
  ): () => void {
    switch (event) {
      case "message.delta":
        return this.session.on("assistant.message_delta", (sdkEvent) => {
          handler({ data: { deltaText: sdkEvent.data.deltaContent } as AISessionEventMap[E] });
        });
      case "tool.complete":
        return this.session.on("tool.execution_complete", () => {
          handler({ data: {} as AISessionEventMap[E] });
        });
      default: {
        const neverEvent: never = event;
        throw new Error(`Unsupported session event: ${String(neverEvent)}`);
      }
    }
  }
}

class CopilotClientAdapter implements AIClient {
  public constructor(private readonly client: CopilotClient) {}

  public getState(): string {
    return this.client.getState();
  }

  public async listModels(): Promise<AIModelInfo[]> {
    const models = await this.client.listModels();
    return models.map(mapModelInfo);
  }

  public async createSession(options: AISessionOptions): Promise<AISession> {
    const session = await this.client.createSession(mapSessionOptions(options));
    return new CopilotSessionAdapter(session);
  }

  public async resumeSession(sessionId: string, options: AISessionOptions): Promise<AISession> {
    const session = await this.client.resumeSession(sessionId, mapSessionOptions(options));
    return new CopilotSessionAdapter(session);
  }

  public async stop(): Promise<void> {
    await this.client.stop();
  }
}

let copilotClient: CopilotClient | undefined;
let adaptedClient: AIClient | undefined;

async function createClient(): Promise<AIClient> {
  copilotClient = new CopilotClient({
    autoStart: true,
    autoRestart: true,
  });
  await copilotClient.start();
  adaptedClient = new CopilotClientAdapter(copilotClient);
  return adaptedClient;
}

export const copilotRuntime: AIProviderRuntime = {
  provider: "copilot",

  async getClient(): Promise<AIClient> {
    if (!copilotClient || !adaptedClient) {
      return createClient();
    }
    return adaptedClient;
  },

  async resetClient(): Promise<AIClient> {
    if (copilotClient) {
      try {
        await copilotClient.stop();
      } catch {
        // best-effort
      }
    }
    copilotClient = undefined;
    adaptedClient = undefined;
    return createClient();
  },

  async stopClient(): Promise<void> {
    if (copilotClient) {
      await copilotClient.stop();
      copilotClient = undefined;
      adaptedClient = undefined;
    }
  },
};