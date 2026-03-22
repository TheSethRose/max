import { config } from "./config.js";
import { isOrchestratorBusy, sendToOrchestrator, type ProactiveChannel } from "./copilot/orchestrator.js";
import { appendSafetyLogEntry, buildHeartbeatPrompt, classifyHeartbeatResult, hasHeartbeatChecklist } from "./workspace.js";

type HeartbeatNotifier = (text: string, channel: ProactiveChannel) => void;
type HeartbeatLogger = (message: string) => void;

const HEARTBEAT_INITIAL_DELAY_MS = 15_000;

function truncateHeartbeatText(text: string, max = 160): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

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

export function startHeartbeatLoop(notify: HeartbeatNotifier, log: HeartbeatLogger = () => {}): () => void {
  if (config.heartbeatEveryMs <= 0) {
    return () => {};
  }

  let inFlight = false;

  const tick = (): void => {
    log("tick started");

    if (inFlight) {
      log("skipped: previous heartbeat still running");
      return;
    }
    if (isOrchestratorBusy()) {
      log("skipped: orchestrator busy");
      return;
    }
    if (!isWithinActiveHours(new Date())) {
      log("skipped: outside active hours");
      return;
    }
    if (!hasHeartbeatChecklist()) {
      log("skipped: HEARTBEAT.md is empty");
      return;
    }

    const prompt = buildHeartbeatPrompt(config.heartbeatAutonomy);
    if (!prompt) {
      log("skipped: heartbeat prompt could not be built");
      return;
    }

    inFlight = true;
    log("dispatching scheduled heartbeat");
    sendToOrchestrator(prompt, { type: "heartbeat" }, (text, done) => {
      if (!done) {
        return;
      }

      try {
        const result = classifyHeartbeatResult(text);
        const channel = resolveHeartbeatChannel();
        log(
          result.kind === "ok"
            ? "result: HEARTBEAT_OK"
            : `result: alert -> ${truncateHeartbeatText(result.text)}`,
        );
        appendSafetyLogEntry(
          result.kind === "ok"
            ? "Scheduled heartbeat completed with HEARTBEAT_OK"
            : `Scheduled heartbeat raised an alert: ${result.text}`,
          result.kind === "ok" ? "ok" : "alert",
        );
        if (result.kind === "alert" && channel !== "none") {
          log(`notifying via ${channel}`);
          notify(result.text, channel);
        }
      } finally {
        inFlight = false;
      }
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      log(`failed: ${truncateHeartbeatText(message)}`);
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