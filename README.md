# Max

AI orchestrator powered by the [GitHub Copilot SDK](https://github.com/github/copilot-sdk) and [Mastra](https://mastra.ai/) — control coding workers and conversations from Telegram or a local terminal.

Max now supports two explicit runtime selections during setup:

- **Use Copilot** — the original Copilot SDK / Copilot CLI-based experience
- **Use Mastra** — a Mastra-backed runtime that uses provider/model IDs like `openai/gpt-4.1` and gives workers a local workspace with filesystem + command execution

GitHub Copilot remains the default.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/TheSethRose/max/main/install.sh | bash
```

Or install directly with npm:

```bash
npm install -g heymax
```

## Quick Start

### 1. Run setup

```bash
max setup
```

This creates `~/.max/` and walks you through configuration (Telegram bot token, etc.). Telegram is optional — you can use Max with just the terminal UI.

Setup also creates a dedicated profile workspace at `~/.max/workspace/profile/` for assistant-specific markdown files like `IDENTITY.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, and `STANDING_ORDERS.md`.

During setup you'll choose either **GitHub Copilot** or **Mastra**.

### 2. Make sure your selected runtime is ready

```bash
copilot login
```

If you selected **Mastra**, setup will save or prompt for the provider API key that matches your model (for example `OPENAI_API_KEY` for `openai/gpt-4.1`).

### Runtime configuration

Max reads `~/.max/.env` and falls back to a project-local `.env` for development.

Supported variables:

- `AI_PROVIDER=copilot`
- `AI_MODEL=claude-sonnet-4.6`
- `CLASSIFIER_MODEL=gpt-4.1`
- `HEARTBEAT_EVERY=0m`
- `HEARTBEAT_TARGET=none`
- `HEARTBEAT_AUTONOMY=observe`
- `HEARTBEAT_ACTIVE_HOURS=08:00-22:00`

Mastra example:

- `AI_PROVIDER=mastra`
- `AI_MODEL=openai/gpt-4.1`
- `CLASSIFIER_MODEL=openai/gpt-4.1`
- `OPENAI_API_KEY=...`

Backward compatibility:

- If `AI_MODEL` is unset and `COPILOT_MODEL` is set, Max will use `COPILOT_MODEL`.
- If `AI_PROVIDER` is unset, Max defaults to `copilot`.

### Profile workspace

Max keeps user-owned profile files outside the repo in:

```bash
~/.max/workspace/profile/
```

These files work alongside `src/copilot/system-message.ts` and `src/copilot/tools.ts`:

- `IDENTITY.md` — who Max is
- `SOUL.md` — tone, boundaries, and behavior
- `USER.md` — who Max is helping
- `TOOLS.md` — machine-specific notes and safe defaults
- `HEARTBEAT.md` — tiny recurring checklist for scheduled awareness
- `STANDING_ORDERS.md` — what Max may do without asking
- `BOOTSTRAP.md` — first-run setup notes

This keeps assistant state out of the repo root while still giving Max durable context.

### Heartbeat automation

Heartbeat is off by default. To enable it, set a cadence and edit `~/.max/workspace/profile/HEARTBEAT.md`.

Example:

```bash
HEARTBEAT_EVERY=30m
HEARTBEAT_TARGET=telegram
HEARTBEAT_AUTONOMY=notify
HEARTBEAT_ACTIVE_HOURS=08:00-22:00
```

Autonomy modes:

- `observe` — inspect only, no tool actions
- `notify` — inspect and notify, but avoid external changes
- `act` — take internal actions only when allowed by `STANDING_ORDERS.md`

If `HEARTBEAT.md` is effectively empty, Max skips heartbeat runs to save tokens.

Example:

```bash
AI_PROVIDER=copilot
AI_MODEL=claude-sonnet-4.6
CLASSIFIER_MODEL=gpt-4.1
```

Mastra example:

```bash
AI_PROVIDER=mastra
AI_MODEL=openai/gpt-4.1
CLASSIFIER_MODEL=openai/gpt-4.1
OPENAI_API_KEY=your-openai-key
```

### 3. Start Max

```bash
max start
```

### 4. Connect via terminal

In a separate terminal:

```bash
max tui
```

### 5. Talk to Max

From Telegram or the TUI, just send natural language:

- "Start working on the auth bug in ~/dev/myapp"
- "What sessions are running?"
- "Check on the api-tests session"
- "Kill the auth-fix session"
- "What's the capital of France?"

## Commands

| Command | Description |
|---------|-------------|
| `max start` | Start the Max daemon |
| `max tui` | Connect to the daemon via terminal |
| `max setup` | Interactive first-run configuration |
| `max update` | Check for and install updates |
| `max help` | Show available commands |

### Flags

| Flag | Description |
|------|-------------|
| `--self-edit` | Allow Max to modify his own source code (use with `max start`) |

### TUI commands

| Command | Description |
|---------|-------------|
| `/model [name]` | Show or switch the current model |
| `/memory` | Show stored memories |
| `/skills` | List installed skills |
| `/workers` | List active worker sessions |
| `/copy` | Copy last response to clipboard |
| `/status` | Daemon health check |
| `/restart` | Restart the daemon |
| `/cancel` | Cancel the current in-flight message |
| `/clear` | Clear the screen |
| `/help` | Show help |
| `/quit` | Exit the TUI |
| `Escape` | Cancel a running response |

## How it Works

Max runs a persistent **orchestrator session** — an always-on AI brain that receives your messages and decides how to handle them. For coding tasks, it spawns **worker sessions** in specific directories. For simple questions, it answers directly.

- With **Copilot**, the orchestrator and workers use the Copilot SDK / Copilot CLI stack.
- With **Mastra**, the orchestrator uses a Mastra agent and workers get a Mastra workspace with local filesystem and sandbox command execution.

You can talk to Max from:
- **Telegram** — remote access from your phone (authenticated by user ID)
- **TUI** — local terminal client (no auth needed)

## Architecture

```
Telegram ──→ Max Daemon ←── TUI
                │
                   Orchestrator Session (Copilot or Mastra)
                │
      ┌─────────┼─────────┐
   Worker 1  Worker 2  Worker N
```

- **Daemon** (`max start`) — persistent service running the selected AI runtime + Telegram bot + HTTP API
- **TUI** (`max tui`) — lightweight terminal client connecting to the daemon
- **Orchestrator** — long-running runtime session with custom tools for session management
- **Workers** — child runtime sessions for specific coding tasks

### Provider notes

- **Copilot** keeps support for listing and attaching to other Copilot CLI sessions on the machine.
- **Mastra** requires Node.js `22.13.0+` and model provider credentials such as `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`, depending on the model you choose.

## Development

```bash
# Clone and install
git clone https://github.com/TheSethRose/max.git
cd max
npm install

# Requires Node.js 22.13.0+

# Watch mode
npm run dev

# Build TypeScript
npm run build
```
