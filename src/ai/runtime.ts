import { config } from "../config.js";
import type { AIClient, AIProviderRuntime } from "./types.js";
import { copilotRuntime } from "../providers/copilot/runtime.js";

function getProviderRuntime(): AIProviderRuntime {
  switch (config.aiProvider) {
    case "copilot":
      return copilotRuntime;
    default:
      throw new Error(`Unsupported AI_PROVIDER '${config.aiProvider}'`);
  }
}

export async function getClient(): Promise<AIClient> {
  return getProviderRuntime().getClient();
}

export async function resetClient(): Promise<AIClient> {
  return getProviderRuntime().resetClient();
}

export async function stopClient(): Promise<void> {
  await getProviderRuntime().stopClient();
}