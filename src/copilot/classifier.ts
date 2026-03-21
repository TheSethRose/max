import { config } from "../config.js";
import type { AIClient, AISession } from "../ai/types.js";
import type { Tier } from "./router.js";

// ---------------------------------------------------------------------------
// Persistent classifier session
// ---------------------------------------------------------------------------

const CLASSIFY_TIMEOUT_MS = 8_000;

const SYSTEM_PROMPT = `You are a message complexity classifier for an AI assistant called Max. Your ONLY job is to classify incoming user messages into one of three tiers. Respond with ONLY the tier name — nothing else.

Tiers:
- FAST: Greetings, thanks, acknowledgments, simple yes/no, trivial factual questions ("what time is it?", "hello", "thanks"), casual chat with no technical depth.
- STANDARD: Coding tasks, file operations, tool usage requests, moderate reasoning, questions about technical topics, requests to create/check/manage things, anything involving code or development workflow.
- PREMIUM: Complex architecture decisions, deep analysis, multi-step reasoning, comparing trade-offs, detailed explanations of complex topics, debugging intricate issues, designing systems, strategic planning.

Rules:
- If unsure, respond STANDARD (it's the safe default).
- Respond with exactly one word: FAST, STANDARD, or PREMIUM.`;

let classifierSession: AISession | undefined;
let sessionClient: AIClient | undefined;

async function ensureSession(client: AIClient): Promise<AISession> {
  // Recreate if the client changed (e.g. after a reset)
  if (classifierSession && sessionClient === client) {
    return classifierSession;
  }

  // Destroy stale session
  if (classifierSession) {
    classifierSession.destroy().catch(() => {});
    classifierSession = undefined;
  }

  classifierSession = await client.createSession({
    model: config.classifierModel,
    streaming: false,
    systemMessage: { content: SYSTEM_PROMPT },
  });
  sessionClient = client;
  return classifierSession;
}

const TIER_MAP: Record<string, Tier> = {
  FAST: "fast",
  STANDARD: "standard",
  PREMIUM: "premium",
};

/**
 * Classify a message using the configured classifier model.
 * Returns the tier, or null if the classifier is unavailable / times out.
 */
export async function classifyWithLLM(
  client: AIClient,
  message: string,
): Promise<Tier | null> {
  try {
    const session = await ensureSession(client);
    const result = await session.sendAndWait(
      { prompt: message },
      CLASSIFY_TIMEOUT_MS,
    );
    const raw = (result?.content || "").trim().toUpperCase();
    return TIER_MAP[raw] ?? "standard";
  } catch (err) {
    console.log(
      `[max] Classifier error (falling back to heuristics): ${err instanceof Error ? err.message : err}`,
    );
    // Destroy broken session so it's recreated next time
    if (classifierSession) {
      classifierSession.destroy().catch(() => {});
      classifierSession = undefined;
    }
    return null;
  }
}

/** Tear down the classifier session (e.g. on shutdown). */
export function stopClassifier(): void {
  if (classifierSession) {
    classifierSession.destroy().catch(() => {});
    classifierSession = undefined;
    sessionClient = undefined;
  }
}
