# Max - Quick Reference Guide

## Project: AI Orchestrator Daemon for Developers

**What it does**: Always-on personal AI assistant that runs on your machine, orchestrates coding workers, learns skills, remembers context.

**~3,530 lines of TypeScript** | Runs 24/7 | Persists to ~/.max/

---

## Commands

| Command | Purpose |
|---------|---------|
| `max start` | Start the daemon (Telegram bot + HTTP API + orchestrator) |
| `max tui` | Connect to daemon via terminal UI |
| `max setup` | Interactive configuration (provider, model, Telegram, Google) |
| `max update` | Check and install updates |
| `max help` | Show help |

### Start Flags
- `--self-edit` : Allow Max to modify its own source code (off by default)

---

## Configuration Files

| Path | Purpose |
|------|---------|
| `~/.max/.env` | Config: TELEGRAM_BOT_TOKEN, AUTHORIZED_USER_ID, API_PORT, AI_PROVIDER, AI_MODEL, CLASSIFIER_MODEL, WORKER_TIMEOUT |
| `~/.max/max.db` | SQLite: worker sessions, conversation log, memories, app state |
| `~/.max/sessions/` | Copilot SDK session storage (keeps history clean) |
| `~/.max/skills/` | User-installed skills (SKILL.md + _meta.json) |
| `~/.max/api-token` | Bearer token for HTTP API (generated once) |
| `~/.max/tui_history` | TUI readline history |
| `~/.copilot/mcp-config.json` | MCP servers (Copilot CLI config, NOT Max's) |

---

## Architecture at a Glance

```
Input Sources:
  Telegram (grammy bot)
  TUI (readline SSE)
  Background (worker completions)
        ↓
  ┌─────────────────────┐
  │  Message Queue      │ (serialized, one-at-a-time)
  └─────────────────────┘
        ↓
  ┌─────────────────────┐
      │  Orchestrator       │ (persistent session via configured provider)
  │  - Route model      │
  │  - Execute tools    │
  │  - Stream response  │
  └─────────────────────┘
        ↓
  ┌──────────────────────────────────┐
  │  Tools Available:                │
  │  - create_worker_session         │
  │  - send_to_worker                │
  │  - learn_skill / uninstall_skill │
  │  - save_memory / recall_memory   │
  │  - list_sessions / kill_session  │
  └──────────────────────────────────┘
        ↓
  Output to user (Telegram, TUI, or background notification)
```

---

## Boot Sequence (simplified)

1. **CLI routes** → `daemon.ts`
2. **Load config** from ~/.max/.env
3. **Init SQLite** database
4. **Start AI runtime client** (Copilot by default; auto-starts if needed)
5. **Init orchestrator**:
   - Load MCP servers from ~/.copilot/mcp-config.json
   - Load skills from ~/.max/skills/, ~/.agents/skills/
   - Resume or create persistent orchestrator session
   - Inject recent conversation context if recovering
   - Start 30s health check loop
6. **Start HTTP API** on port 7777 (Express)
7. **Start Telegram bot** (if configured)
8. **Wire up proactive notifications** (background → user channel)
9. **Non-blocking update check**
10. **Ready for messages**

---

## Message Processing Pipeline

```
Message arrives (any source)
  ↓
  Add channel tag ([via telegram], [via tui], [via background])
  ↓
  Enqueue to messageQueue
  ↓
  processQueue() (serialized):
    ├─ resolveModel()
    │  ├─ Check keyword overrides (e.g., "design" → premium)
    │  ├─ Classify intent (fast/standard/premium)
    │  ├─ Lookup tier → model mapping
    │  └─ If switching: destroy session, recreate
    │
    └─ executeOnSession()
       ├─ Ensure orchestrator session exists
       ├─ session.sendAndWait(prompt, 300s timeout)
       ├─ Stream deltas, call callback(partialText, done:false)
       ├─ On complete: callback(fullText, done:true)
       └─ Retry up to 3x on recoverable errors (backoff: 1s, 3s, 10s)
  ↓
  Log to database: conversation_log table
  ↓
  Deliver to user (Telegram, TUI, or queue for background)
```

---

## Worker Session Model

Workers are **temporary Copilot CLI sessions** spawned on demand:

- **When**: Orchestrator decides task needs coding/file ops
- **Where**: Specific working directory (~/dev/myapp, etc.)
- **How**: `create_worker_session(name, working_dir, initial_prompt)`
- **Returns**: Immediately (non-blocking)
- **Background**: Worker runs async, reports back when done
- **Channel**: Remembers origin channel (telegram/tui) to route completion back
- **Limit**: Max 5 concurrent workers
- **Protected**: Cannot operate in ~/.ssh, ~/.gnupg, ~/.aws, etc.

---

## Skills System

**Bundled Skills**:
- `find-skills` : Discover & install skills from https://skills.sh/
- `gogcli` : Access Gmail, Calendar, Drive via gog CLI

**Skill Format**:
- `SKILL.md` : Markdown with YAML frontmatter (name, description)
- `_meta.json` : Metadata { slug, version }
- Location: `~/.max/skills/{slug}/` (or `~/.agents/skills/`)

**Skill Injection**:
- At session creation: entire SKILL.md injected into system message
- Max reads instructions, decides when/how to use
- Skills are **documentation, not code**

**Skill Management Tools**:
- `learn_skill(slug, name, description, instructions)` : Create skill in ~/.max/skills/
- `uninstall_skill(slug)` : Delete from ~/.max/skills/

---

## Data Persistence (SQLite)

**Tables**:

1. `worker_sessions` : Metadata for long-running worker sessions
2. `max_state` : Key-value store (orchestrator_session_id, router_config, etc.)
3. `conversation_log` : Full audit trail (user, assistant, system messages)
   - Retention: Last 200 entries only
   - Purpose: Context recovery if session lost
4. `memories` : Long-term knowledge
   - Categories: preference, fact, project, person, routine
   - Injected into system message as summary

**Memory Flow**:
- User or Max calls `save_memory(category, content)`
- Query via `recall_memory(keyword, category)`
- Formatted via `getMemorySummary()` → included in system message

---

## Key Design Patterns

### 1. Single-Threaded Orchestrator
- Message queue ensures one message at a time
- Prevents concurrent state corruption
- Queued messages wait if orchestrator busy
- Enables retries without losing queue

### 2. Persistent Session
- Orchestrator session survives daemon restarts
- Session ID saved in max_state table
- Resume or create on next boot
- Recent conversation injected to recover context

### 3. Health Check Loop
- Every 30s: checks if the active AI runtime client is still connected
- If disconnected: auto-reconnect
- If reconnect fails: session becomes stale, recreated on next message

### 4. Channel-Aware Processing
- Messages tagged with source (telegram/tui/background)
- Workers inherit originChannel
- Completions routed back to originating channel
- Different formatting per channel (Telegram: short; TUI: verbose)

### 5. Intelligent Model Routing
- Keyword-based overrides (design task → premium)
- LLM classification of message intent
- Configurable tier → model mapping
- Auto-switch if needed

### 6. Tool Callback Pattern
- Tools return immediately (non-blocking)
- Work happens in background
- Completion delivered via feedBackgroundResult()
- Callback receives partial updates as stream

---

## External Dependencies

| Dependency | Purpose | Default Installed? |
|------------|---------|-------------------|
| **Copilot CLI** | Current built-in AI provider runtime, models, session mgmt | ✓ Required today |
| **Telegram Bot API** | Remote messaging | ✗ Optional |
| **gogcli** | Google services | ✗ Optional |
| **skills.sh API** | Skill discovery | (online, optional) |
| **npm Registry** | Update checking | (online, optional) |

---

## TUI Commands

| Command | Purpose |
|---------|---------|
| `/model` | Show or switch current model |
| `/memory` | Show stored memories |
| `/skills` | List installed skills |
| `/workers` | List active worker sessions |
| `/copy` | Copy last response to clipboard |
| `/status` | Daemon health check |
| `/restart` | Restart the daemon |
| `/cancel` | Cancel in-flight message |
| `/clear` | Clear screen |
| `/help` | Show help |
| `/quit` or `Escape` | Exit TUI |

---

## HTTP API (localhost:7777)

All routes require Bearer token from ~/.max/api-token (except /status).

| Method | Route | Purpose |
|--------|-------|---------|
| POST | `/message` | Send message to orchestrator |
| GET | `/stream` | Server-sent events (SSE) stream |
| GET | `/sessions` | List active workers |
| GET | `/status` | Health check (no auth) |
| POST | `/cancel` | Cancel the current in-flight message |
| GET | `/model` | Show active model |
| POST | `/model` | Switch active model |
| GET | `/auto` | Show auto-routing config |
| POST | `/auto` | Update auto-routing config |
| GET | `/memory` | Query memories |
| GET | `/skills` | List skills |
| DELETE | `/skills/{slug}` | Remove skill |
| POST | `/restart` | Restart daemon |
| POST | `/send-photo` | Send a photo through Telegram |

---

## Important Notes

### Security
- Telegram bot locked to specific user ID (no auth bypass)
- Blocked directories prevent accidents (no ~/.ssh modifications)
- Self-edit mode off by default (Max can't modify own code)
- API token generated once, stored as file (mode 0o600)

### Performance
- Message processing serialized (one-at-a-time, no race conditions)
- Worker limit 5 concurrent (prevents resource exhaustion)
- Conversation log pruned to 200 entries (manageable context)
- Health check every 30s (not aggressive, not lazy)

### Reliability
- Retry logic with exponential backoff (1s, 3s, 10s)
- Session resume on crash (context injected)
- Graceful shutdown (destroy workers, close DB)
- Force exit after 3s (prevents hangs)

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "Copilot CLI not found" | Install: `npm install -g @github/copilot` |
| "Not authenticated" | Run: `copilot login` |
| Telegram not working | Run: `max setup` and configure token + user ID |
| Model unavailable | Re-run `max setup` or switch to a model exposed by your configured provider |
| Skills not found | Check ~/.max/skills/ and ~/.agents/skills/ have SKILL.md files |
| Workers stuck | Check WORKER_TIMEOUT in ~/.max/.env |
| Daemon crashed | Restart: `max start` (session resumes automatically) |

---

## Key Files (by importance)

| File | Lines | Role |
|------|-------|------|
| `src/copilot/orchestrator.ts` | 441 | Persistent session, message queue, retries |
| `src/tui/index.ts` | 1,026 | Terminal UI (TUI) |
| `src/copilot/tools.ts` | 576 | Worker, skill, memory tools |
| `src/daemon.ts` | ~180 | Boot sequence, shutdown |
| `src/api/server.ts` | 281 | HTTP API (Express) |
| `src/telegram/bot.ts` | 244 | Telegram bot (grammy) |
| `src/store/db.ts` | 208 | SQLite persistence |
| `src/copilot/router.ts` | 201 | Model selection logic |
| `src/setup.ts` | 313 | Interactive setup wizard |
| `src/config.ts` | 90 | Config loading & persistence |
