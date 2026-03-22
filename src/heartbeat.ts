import { config } from "./config.js";
import { isOrchestratorBusy, sendToOrchestrator, type ProactiveChannel } from "./copilot/orchestrator.js";
import { buildHeartbeatPrompt, classifyHeartbeatResult, hasHeartbeatChecklist } from "./workspace.js";

type HeartbeatNotifier = (text: string, channel: ProactiveChannel) => void;

function isWithinActiveHours(now: Date): boolean {
  const range = config.heartbeatActiveHours;
  if (!range) {
    return true;
  }

  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  if (range.startMinutes < range.endMinutes) {
    return currentMinutes >= range.startMinutes && currentMinutes < range.endMinutes;
  }

  return currentMinutes >= range.startMinutes || currentMinutes < range.endMinutes;
}

function resolveHeartbeatChannel(): ProactiveChannel {
  return config.heartbeatTarget;
}

export function startHeartbeatLoop(notify: HeartbeatNotifier): () => void {
  if (config.heartbeatEveryMs <= 0) {
    return () => {};
  }

  let inFlight = false;

  const tick = (): void => {
    if (inFlight || isOrchestratorBusy()) {
      return;
    }
    if (!isWithinActiveHours(new Date())) {
      return;
    }
    if (!hasHeartbeatChecklist()) {
      return;
    }

    const prompt = buildHeartbeatPrompt(config.heartbeatAutonomy);
    if (!prompt) {
      return;
    }

    inFlight = true;
    sendToOrchestrator(prompt, { type: "heartbeat" }, (text, done) => {
      if (!done) {
        return;
      }

      try {
        const result = classifyHeartbeatResult(text);
        const channel = resolveHeartbeatChannel();
        if (result.kind === "alert" && channel !== "none") {
          notify(result.text, channel);
        }
      } finally {
        inFlight = false;
      }
    }).catch(() => {
      inFlight = false;
    });
  };

  const timer = setInterval(tick, config.heartbeatEveryMs);
  timer.unref?.();
  return () => clearInterval(timer);
}