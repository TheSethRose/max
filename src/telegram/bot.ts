import { Bot, GrammyError, HttpError, type Context } from "grammy";
import { config, persistModel } from "../config.js";
import { sendToOrchestrator, cancelCurrentMessage, getWorkers, getLastRouteResult, resetOrchestratorSession } from "../copilot/orchestrator.js";
import { chunkMessage, toTelegramMarkdown } from "./formatter.js";
import { searchMemories } from "../store/db.js";
import { listSkills } from "../copilot/skills.js";
import { restartDaemon } from "../daemon.js";
import { getRouterConfig, updateRouterConfig } from "../copilot/router.js";
import { getClient } from "../ai/runtime.js";

let bot: Bot | undefined;

type ChunkSendOptions = {
  replyToMessageId?: number;
  markdown?: boolean;
};

async function replyInChunks(ctx: Context, text: string, options: ChunkSendOptions = {}): Promise<void> {
  const primaryText = options.markdown ? toTelegramMarkdown(text) : text;
  const primaryChunks = chunkMessage(primaryText);
  const fallbackChunks = options.markdown ? chunkMessage(text) : primaryChunks;

  for (let i = 0; i < primaryChunks.length; i++) {
    const isFirst = i === 0;
    const replyOptions = isFirst && options.replyToMessageId
      ? { reply_parameters: { message_id: options.replyToMessageId } }
      : {};

    if (!options.markdown) {
      await ctx.reply(primaryChunks[i], replyOptions);
      continue;
    }

    try {
      await ctx.reply(primaryChunks[i], {
        ...replyOptions,
        parse_mode: "MarkdownV2",
      });
    } catch {
      await ctx.reply(fallbackChunks[i] ?? primaryChunks[i], replyOptions);
    }
  }
}

async function sendAuthorizedUserText(text: string, options: { markdown?: boolean } = {}): Promise<void> {
  if (!bot || config.authorizedUserId === undefined) return;

  const primaryText = options.markdown ? toTelegramMarkdown(text) : text;
  const primaryChunks = chunkMessage(primaryText);
  const fallbackChunks = options.markdown ? chunkMessage(text) : primaryChunks;

  for (let i = 0; i < primaryChunks.length; i++) {
    if (!options.markdown) {
      await bot.api.sendMessage(config.authorizedUserId, primaryChunks[i]);
      continue;
    }

    try {
      await bot.api.sendMessage(config.authorizedUserId, primaryChunks[i], {
        parse_mode: "MarkdownV2",
      });
    } catch {
      await bot.api.sendMessage(config.authorizedUserId, fallbackChunks[i] ?? primaryChunks[i]);
    }
  }
}

async function syncTelegramCommands(instance: Bot): Promise<void> {
  await instance.api.setMyCommands([
    { command: "new", description: "Start a fresh session" },
    { command: "cancel", description: "Cancel the current message" },
    { command: "model", description: "Show or switch model" },
    { command: "auto", description: "Toggle auto model routing" },
    { command: "memory", description: "Show stored memories" },
    { command: "skills", description: "List installed skills" },
    { command: "workers", description: "List active worker sessions" },
    { command: "restart", description: "Restart Max" },
    { command: "help", description: "Show help" },
  ]);
}

async function handleFreshSessionCommand(ctx: Context): Promise<void> {
  await resetOrchestratorSession();
  await replyInChunks(ctx, "✨ Fresh session ready. Send me your next message.", {
    replyToMessageId: ctx.msg?.message_id,
  });
}

export function createBot(): Bot {
  if (!config.telegramBotToken) {
    throw new Error("Telegram bot token is missing. Run 'max setup' and enter the bot token from @BotFather.");
  }
  if (config.authorizedUserId === undefined) {
    throw new Error("Telegram user ID is missing. Run 'max setup' and enter your Telegram user ID (get it from @userinfobot).");
  }
  bot = new Bot(config.telegramBotToken);

  bot.catch((err) => {
    const updateId = err.ctx?.update?.update_id;
    if (err.error instanceof GrammyError) {
      console.error(`[max] Telegram API error${updateId ? ` on update ${updateId}` : ""}: ${err.error.description}`);
      return;
    }
    if (err.error instanceof HttpError) {
      console.error(`[max] Telegram network error${updateId ? ` on update ${updateId}` : ""}:`, err.error);
      return;
    }
    console.error(`[max] Telegram middleware error${updateId ? ` on update ${updateId}` : ""}:`, err.error);
  });

  // Auth middleware — only allow the authorized user
  bot.use(async (ctx, next) => {
    if (config.authorizedUserId !== undefined && ctx.from?.id !== config.authorizedUserId) {
      return; // Silently ignore unauthorized users
    }
    await next();
  });

  // /start and /help
  bot.command("start", (ctx) =>
    replyInChunks(ctx, "Max is online. Send me anything.", { replyToMessageId: ctx.msg?.message_id })
  );
  bot.command("help", (ctx) =>
    replyInChunks(
      ctx,
      "I'm Max, your AI daemon.\n\n" +
        "Just send me a message and I'll handle it.\n\n" +
        "Commands:\n" +
        "/new — Start a fresh session\n" +
        "/cancel — Cancel the current message\n" +
        "/model — Show current model\n" +
        "/model <name> — Switch model\n" +
        "/auto — Toggle auto model routing\n" +
        "/memory — Show stored memories\n" +
        "/skills — List installed skills\n" +
        "/workers — List active worker sessions\n" +
        "/restart — Restart Max\n" +
        "/help — Show this help",
      { replyToMessageId: ctx.msg?.message_id }
    )
  );
  bot.command("cancel", async (ctx) => {
    const cancelled = await cancelCurrentMessage();
    await replyInChunks(ctx, cancelled ? "⛔ Cancelled." : "Nothing to cancel.", {
      replyToMessageId: ctx.msg?.message_id,
    });
  });
  bot.command("new", handleFreshSessionCommand);
  bot.command("reset", handleFreshSessionCommand);
  bot.command("model", async (ctx) => {
    const arg = ctx.match?.trim();
    if (arg) {
      // Validate against available models before persisting
      try {
        const client = await getClient();
        const models = await client.listModels();
        const match = models.find((m) => m.id === arg);
        if (!match) {
          const suggestions = models
            .filter((m) => m.id.includes(arg) || m.id.toLowerCase().includes(arg.toLowerCase()))
            .map((m) => m.id);
          const hint = suggestions.length > 0 ? ` Did you mean: ${suggestions.join(", ")}?` : "";
          await replyInChunks(ctx, `Model '${arg}' not found.${hint}`, {
            replyToMessageId: ctx.msg?.message_id,
          });
          return;
        }
      } catch {
        // If validation fails (client not ready), allow the switch — will fail on next message if wrong
      }
      const previous = config.aiModel;
      config.aiModel = arg;
      persistModel(arg);
      await replyInChunks(ctx, `Model: ${previous} → ${arg}`, {
        replyToMessageId: ctx.msg?.message_id,
      });
    } else {
      await replyInChunks(ctx, `Current model: ${config.aiModel}`, {
        replyToMessageId: ctx.msg?.message_id,
      });
    }
  });
  bot.command("memory", async (ctx) => {
    const memories = searchMemories(undefined, undefined, 50);
    if (memories.length === 0) {
      await replyInChunks(ctx, "No memories stored.", { replyToMessageId: ctx.msg?.message_id });
    } else {
      const lines = memories.map((m) => `#${m.id} [${m.category}] ${m.content}`);
      await replyInChunks(ctx, lines.join("\n") + `\n\n${memories.length} total`, {
        replyToMessageId: ctx.msg?.message_id,
      });
    }
  });
  bot.command("skills", async (ctx) => {
    const skills = listSkills();
    if (skills.length === 0) {
      await replyInChunks(ctx, "No skills installed.", { replyToMessageId: ctx.msg?.message_id });
    } else {
      const lines = skills.map((s) => `• ${s.name} (${s.source}) — ${s.description}`);
      await replyInChunks(ctx, lines.join("\n"), { replyToMessageId: ctx.msg?.message_id });
    }
  });
  bot.command("workers", async (ctx) => {
    const workers = Array.from(getWorkers().values());
    if (workers.length === 0) {
      await replyInChunks(ctx, "No active worker sessions.", { replyToMessageId: ctx.msg?.message_id });
    } else {
      const lines = workers.map((w) => `• ${w.name} (${w.workingDir}) — ${w.status}`);
      await replyInChunks(ctx, lines.join("\n"), { replyToMessageId: ctx.msg?.message_id });
    }
  });
  bot.command("restart", async (ctx) => {
    await replyInChunks(ctx, "⏳ Restarting Max...", { replyToMessageId: ctx.msg?.message_id });
    setTimeout(() => {
      restartDaemon().catch((err) => {
        console.error("[max] Restart failed:", err);
      });
    }, 500);
  });
  bot.command("auto", async (ctx) => {
    const current = getRouterConfig();
    const newState = !current.enabled;
    updateRouterConfig({ enabled: newState });
    const label = newState
      ? "⚡ Auto mode on"
      : `Auto mode off · using ${config.aiModel}`;
    await replyInChunks(ctx, label, { replyToMessageId: ctx.msg?.message_id });
  });

  // Handle all text messages
  bot.on("message:text", async (ctx) => {
    const chatId = ctx.chat.id;
    const userMessageId = ctx.message.message_id;

    // Show "typing..." indicator, repeat every 4s while processing
    let typingInterval: ReturnType<typeof setInterval> | undefined;
    const startTyping = () => {
      void ctx.replyWithChatAction("typing").catch(() => {});
      typingInterval = setInterval(() => {
        void ctx.replyWithChatAction("typing").catch(() => {});
      }, 4000);
    };
    const stopTyping = () => {
      if (typingInterval) {
        clearInterval(typingInterval);
        typingInterval = undefined;
      }
    };

    startTyping();

    sendToOrchestrator(
      ctx.message.text,
      { type: "telegram", chatId, messageId: userMessageId },
      (text: string, done: boolean) => {
        if (done) {
          stopTyping();
          // Send final message — use chunking for long responses, reply-quote original
          void (async () => {
            // Append model indicator
            const routeResult = getLastRouteResult();
            let indicatorSuffix = "";
            if (routeResult && routeResult.routerMode === "auto") {
              indicatorSuffix = `\n\n⚡ auto · ${routeResult.model}`;
            }
            const primaryText = text + indicatorSuffix;
            try {
              await replyInChunks(ctx, primaryText, {
                replyToMessageId: userMessageId,
                markdown: true,
              });
            } catch {
              try {
                await replyInChunks(ctx, primaryText, {
                  replyToMessageId: userMessageId,
                });
              } catch {
                // Nothing more we can do
              }
            }
          })();
        }
      }
    );
  });

  return bot;
}

export async function startBot(): Promise<void> {
  if (!bot) throw new Error("Bot not created");
  const instance = bot;
  console.log("[max] Telegram bot starting...");
  instance.start({
    onStart: async () => {
      console.log("[max] Telegram bot connected");
      try {
        await syncTelegramCommands(instance);
      } catch (err) {
        console.error("[max] Failed to sync Telegram commands:", err instanceof Error ? err.message : err);
      }
    },
  }).catch((err: any) => {
    if (err?.error_code === 401) {
      console.error("[max] ⚠️ Telegram bot token is invalid or expired. Run 'max setup' and re-enter your bot token from @BotFather.");
    } else if (err?.error_code === 409) {
      console.error("[max] ⚠️ Another bot instance is already running with this token. Stop the other instance first.");
    } else {
      console.error("[max] ❌ Telegram bot failed to start:", err?.message || err);
    }
  });
}

export async function stopBot(): Promise<void> {
  if (bot) {
    await bot.stop();
  }
}

/** Send an unsolicited message to the authorized user (for background task completions). */
export async function sendProactiveMessage(text: string): Promise<void> {
  try {
    await sendAuthorizedUserText(text, { markdown: true });
  } catch {
    // Bot may not be connected yet
  }
}

/** Send a photo to the authorized user. Accepts a file path or URL. */
export async function sendPhoto(photo: string, caption?: string): Promise<void> {
  if (!bot || config.authorizedUserId === undefined) return;
  try {
    const { InputFile } = await import("grammy");
    const input = photo.startsWith("http") ? photo : new InputFile(photo);
    await bot.api.sendPhoto(config.authorizedUserId, input, {
      caption,
    });
  } catch (err) {
    console.error("[max] Failed to send photo:", err instanceof Error ? err.message : err);
    throw err;
  }
}
