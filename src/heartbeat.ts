import { config } from "./config.js";
import { isOrchestratorBusy, sendToOrchestrator, type ProactiveChannel } from "./copilot/orchestrator.js";
import { appendSafetyLogEntry, buildHeartbeatPrompt, classifyHeartbeatResult, hasHeartbeatChecklist } from "./workspace.js";

type HeartbeatNotifier = (text: string, channel: ProactiveChannel) => void;

const HEARTBEAT_INITIAL_DELAY_MS = 15_000;

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
        appendSafetyLogEntry(
          result.kind === "ok"
            ? "Scheduled heartbeat completed with HEARTBEAT_OK"
            : `Scheduled heartbeat raised an alert: ${result.text}`,
          result.kind === "ok" ? "ok" : "alert",
        );
        if (result.kind === "alert" && channel !== "none") {
          notify(result.text, channel);
        }
      } finally {
        inFlight = false;
      }
    }).catch(() => {
      appendSafetyLogEntry("Scheduled heartbeat failed before producing a result", "error");
      inFlight = false;
    });
  };

  const timer = setInterval(tick, config.heartbeatEveryMs);
  timer.unref?.();
  const initialTimer = setTimeout(tick, Math.min(config.heartbeatEveryMs, HEARTBEAT_INITIAL_DELAY_MS));
  initialTimer.unref?.();

  return () => {
    clearInterval(timer);
    clearTimeout(initialTimer);
  };
}