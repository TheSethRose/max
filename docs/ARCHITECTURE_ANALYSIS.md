# Max Codebase Architecture - Comprehensive Analysis

## Project Overview

**Max** is an AI orchestrator daemon built on the GitHub Copilot SDK. It's a personal AI assistant for developers that runs 24/7 on a user's machine, providing:
- **Always-on orchestrator** session that runs on the configured AI provider (default: Copilot)
- **Multiple interfaces**: Telegram (remote), TUI (local terminal), HTTP API (programmatic)
- **Worker sessions**: Spawns child Copilot CLI sessions for coding tasks, debugging, file operations
- **Skill system**: Learns and stores skills for external tools (Gmail, Google Calendar, CLI tools)
- **Model routing**: Intelligent model selection based on task complexity
- **Long-term memory**: Stores user preferences, facts, projects, people, routines in SQLite

**Key Stats**: ~3,530 lines of TypeScript across 13 core modules

---

## 1. Overall Architecture

### High-Level Design
```
Telegram Bot ──→ ┌─────────────────┐ ←── TUI Terminal UI
                 │  Max Daemon     │
              ┌─ │ (HTTP API:7777) │ ←── API Clients
              │  │                 │
              │  │ Orchestrator    │
              │  │ Session         │
              │  │ (AI provider:   │
              │  │  Copilot by     │
              │  │  default)       │
              │  └────────┬────────┘
              │           │
              └───────────┼────────────────────┐
                   ┌──────┴──────┐             │
                 Worker 1    Worker 2    Worker N
                (Copilot CLI sessions)
```

### Core Components (src/ directory structure):
```
src/
├── cli.ts              (Entry point, command router)
├── daemon.ts           (Main daemon process, initialization)
├── setup.ts            (Interactive setup wizard)
├── config.ts           (Configuration, env var management)
├── paths.ts            (Path constants for ~/.max/)
├── update.ts           (Update checking)
│
├── ai/                 (Provider-neutral runtime contracts + selector)
│  ├── runtime.ts       (Dispatch to configured AI provider)
│  └── types.ts         (AIClient/AISession abstractions)
│
├── copilot/            (Orchestrator logic, routing, skills, provider-facing helpers)
│  ├── orchestrator.ts  (Persistent AI session, message queueing)
│  ├── client.ts        (Compatibility re-export to active runtime client)
│  ├── tools.ts         (Worker session tools, skills, memory tools)
│  ├── system-message.ts (System prompt for orchestrator)
│  ├── router.ts        (Intelligent model selection)
│  ├── classifier.ts    (LLM-based request classification)
│  ├── skills.ts        (Skill discovery, installation, management)
│  └── mcp-config.ts    (MCP server loading from ~/.copilot/mcp-config.json)
│
├── providers/          (Concrete provider implementations)
│  └── copilot/
│     └── runtime.ts    (Copilot SDK adapter)
│
├── store/              (Persistence layer)
│  └── db.ts            (SQLite: worker sessions, state, conversations, memories)
│
├── telegram/           (Telegram Bot integration)
│  ├── bot.ts           (grammy bot, commands, message handling)
│  └── formatter.ts     (Message chunking, markdown formatting)
│
├── api/                (HTTP API for TUI)
│  └── server.ts        (Express routes: POST /send, GET /events, etc.)
│
└── tui/                (Terminal UI)
   └── index.ts         (1,026 lines: readline interface, SSE events)
```

---

## 2. Install Experience (install.sh → setup.ts)

### install.sh Workflow:
```bash
curl -fsSL https://raw.githubusercontent.com/TheSethRose/max/main/install.sh | bash
```

1. **Prerequisites Check**:
   - Node.js ≥18 (required)
   - npm (required)
   - Copilot CLI (warned if missing)
   - gogcli (optional, enables Google services)

2. **Two Install Paths**:
   - **Normal**: `npm install -g heymax` (from npm registry)
   - **Dev Mode**: Build locally, run setup from dist/

3. **Runs setup.ts** automatically

### setup.ts Interactive Flow:
Location: `~/.max/` (created with mkdirSync)

**Step 1: Meet Max**
- Explains capabilities, skills system, communication channels

**Step 2: Telegram (Optional)**
- User creates bot via @BotFather → copies token
- User gets ID from @userinfobot → locks bot to that user ID
- Recommend disabling group joins in @BotFather

**Step 3: Google Services (Optional)**
- Install gogcli: `brew install steipete/tap/gogcli`
- Create Google OAuth credentials
- Run `gog auth add email@gmail.com`

**Step 4: Provider Selection**
- User selects the AI runtime provider
- Current built-in option: `copilot`

**Step 5: Model Selection**
- Tries to fetch models from the selected provider (currently Copilot)
- Falls back to hardcoded list: Claude Sonnet 4.6, GPT-5.1, GPT-4.1
- Saves to ~/.max/.env

**Step 6: Writes ~/.max/.env**
```env
TELEGRAM_BOT_TOKEN=token_or_empty
AUTHORIZED_USER_ID=numeric_id_or_empty
API_PORT=7777
AI_PROVIDER=copilot
AI_MODEL=claude-sonnet-4.6
CLASSIFIER_MODEL=gpt-4.1
WORKER_TIMEOUT=600000
```

Legacy compatibility: if `AI_MODEL` is unset, Max still reads `COPILOT_MODEL`.

---

## 3. MCP Server Configuration & Integration

### MCP Loading (mcp-config.ts)
**Source**: `~/.copilot/mcp-config.json` (Copilot CLI's config, NOT Max's)

```typescript
function loadMcpConfig(): Record<string, MCPServerConfig> {
  const configPath = join(homedir(), ".copilot", "mcp-config.json");
  // Parse mcpServers from JSON, return empty {} if not found
}
```

### MCP Server Registration
**In orchestrator.ts** (line 254):
```typescript
const mcpServers = loadMcpConfig();
console.log(`[max] Loading ${Object.keys(mcpServers).length} MCP server(s): ${Object.keys(mcpServers).join(", ")}`);

// Passed to Copilot SDK when creating sessions:
const session = await client.createSession({
  mcpServers,
  skillDirectories,
  // ...
});
```

### How MCP Servers Work:
1. User configures MCP servers in `~/.copilot/mcp-config.json` (Copilot CLI)
2. Max loads them at orchestrator init time
3. **Both orchestrator and worker sessions** receive the same MCP config
4. Tools exposed by MCP servers become available in system message
5. No Max-specific MCP management—delegates to Copilot SDK

---

## 4. Skill Management System

### Three-Tier Skill Directories:
```
1. BUNDLED_SKILLS_DIR    = /path/to/max/package/skills/ (find-skills, gogcli)
2. LOCAL_SKILLS_DIR      = ~/.max/skills/                (user-installed)
3. GLOBAL_SKILLS_DIR     = ~/.agents/skills/             (shared across agents)
```

### Skill Discovery (skills.ts):
```typescript
export function listSkills(): SkillInfo[] {
  // Scans all 3 directories for SKILL.md files
  // Returns: { slug, name, description, directory, source }
}
```

### Skill Format (SKILL.md):
```markdown
---
name: Google (gogcli)
description: Access Gmail, Calendar, Drive, etc. via gog CLI
---

# Detailed instructions for Max on how to use this skill
- When to use
- Command syntax
- Examples
- Error handling
```

- `SKILL.md` is injected into system message at session create time
- Each skill is a directory with `SKILL.md` (instructions) + `_meta.json`
- Skills are **not executables**—they're documentation that teach Max how to use external tools

### Skill Management Tools (in tools.ts):
```typescript
defineTool("learn_skill", {
  // Creates new skill in ~/.max/skills/{slug}/ with SKILL.md
});

defineTool("uninstall_skill", {
  // Deletes skill from ~/.max/skills/{slug}/
});
```

### find-skills Bundled Skill:
- Searches https://skills.sh/ API
- Fetches security audits from skills.sh/audits
- Guides users through installation with security warnings
- Installs via `learn_skill` to ~/.max/skills/

### gogcli Bundled Skill:
- Teaches Max how to use `gog` CLI for Gmail, Calendar, Drive, Contacts, Tasks, Sheets, Docs
- Covers auth, important flags, common operations

---

## 5. Setup & Boot Flow (daemon.ts)

### `max start` Command Flow:

**cli.ts** routes `start` → loads `daemon.ts`

**daemon.ts main() sequence**:

1. **Config Init** (config.ts):
   - Loads `~/.max/.env` via dotenv
  - Validates: TELEGRAM_BOT_TOKEN, AUTHORIZED_USER_ID, API_PORT, AI_PROVIDER, AI_MODEL, CLASSIFIER_MODEL, WORKER_TIMEOUT
  - Reads `AI_MODEL || COPILOT_MODEL || DEFAULT_AI_MODEL`
  - Supports dynamic model switching via `config.aiModel`

2. **Database Init** (store/db.ts):
   ```typescript
   getDb(); // SQLite connection + schema creation
   ```
   - Creates tables: worker_sessions, max_state, conversation_log, memories
   - Prunes conversation_log to last 200 entries

3. **AI Runtime Client** (`ai/runtime.ts` + `providers/copilot/runtime.ts`):
   ```typescript
  const client = await getClient(); // AIClient for configured provider
  // Current built-in provider: Copilot
   ```

4. **Orchestrator Init** (orchestrator.ts):
   ```typescript
   await initOrchestrator(client);
   ```
   - Validates configured model against available models
   - Logs MCP servers and skill directories
   - **Eagerly creates/resumes persistent orchestrator session**:
     - Tries to resume from saved session ID (max_state.orchestrator_session_id)
     - If resumption fails, creates fresh session
     - Injects recent conversation context if session was lost
   - Starts health check (reconnects client every 30s if disconnected)

5. **Message Logger Wiring**:
   ```typescript
   setMessageLogger((direction, source, text) => {
     console.log(`[max] ${tag} ${arrow} ${truncate(text)}`);
   });
   ```

6. **HTTP API Server** (api/server.ts):
   ```typescript
   await startApiServer(); // Express on port 7777
  // Routes: POST /message, GET /stream (SSE), /sessions, /memory, /model, /auto, etc.
   // Auth: Bearer token in ~/.max/api-token (generated once)
   ```

7. **Telegram Bot** (telegram/bot.ts):
   - Only if `config.telegramEnabled` (token + userId both present)
   - Uses grammy library
   - Auth middleware: silently ignores non-authorized users
   - Commands: /cancel, /model, /memory, /skills, /workers, /restart

8. **Proactive Notify Wiring**:
   ```typescript
   setProactiveNotify((text, channel) => {
     // Routes background worker completions to originating channel
   });
   ```

9. **Non-blocking Update Check**:
   - Compares installed version with npm registry
   - Logs if update available

10. **Graceful Shutdown**:
    - SIGINT/SIGTERM handlers
    - Destroys active workers
    - Closes client, database
    - 3-second force exit timeout

### Health Check Loop:
- Every 30 seconds: checks if the active AI client is still connected
- If disconnected: calls ensureClient() to reset
- Invalidates orchestrator session if client reset

---

## 6. Dependency & External Service Handling

### Dependencies (package.json):
```json
{
  "@github/copilot-sdk": "^0.1.26",      // Core AI orchestration
  "better-sqlite3": "^12.6.2",           // Local persistence
  "dotenv": "^17.3.1",                   // .env loading
  "express": "^5.2.1",                   // HTTP API
  "grammy": "^1.40.0",                   // Telegram bot
  "zod": "^4.3.6"                        // Config validation
}
```

### External Services:
1. **AI Runtime Provider** (current built-in provider: GitHub Copilot CLI):
  - Runtime selected via `AI_PROVIDER` (default: `copilot`)
  - Copilot runtime is automatically started if not running
   - User must have `copilot login` authenticated
   - Provides LLM models, tool execution, session management

2. **Telegram Bot API** (optional):
   - grammy library handles all communication
   - Requires TELEGRAM_BOT_TOKEN + AUTHORIZED_USER_ID
   - Runs long polling inside bot process

3. **Google APIs** (optional, via gogcli):
   - User installs gogcli independently
   - gogcli handles OAuth, credentials storage
   - Max calls gog CLI commands in worker sessions

4. **skills.sh API** (optional, for skill discovery):
   - Used by find-skills skill: `curl https://skills.sh/api/search?q=...`
   - Returns JSON with skill metadata, install counts
   - Also fetches `https://skills.sh/audits` for security scores

5. **npm Registry** (update checking):
   - Checks for new versions of "heymax" package
   - Non-blocking, cached response

### Sensitive Directory Protection:
Workers cannot operate in:
```
~/.ssh, ~/.gnupg, ~/.aws, ~/.azure, ~/.config/gcloud,
~/.kube, ~/.docker, ~/.npmrc, ~/.pypirc
```
Path traversal validation prevents escape.

---

## 7. Configuration Patterns (config.ts)

### Environment Variables:
```typescript
// Read from ~/.max/.env (or cwd/.env for dev)
TELEGRAM_BOT_TOKEN=string|undefined        // Telegram bot token
AUTHORIZED_USER_ID=string|undefined        // Numeric Telegram user ID
API_PORT=string (default: 7777)            // HTTP API port
AI_PROVIDER=string (default: copilot)      // AI runtime provider
AI_MODEL=string (default: claude-sonnet-4.6)
CLASSIFIER_MODEL=string (default: gpt-4.1)
COPILOT_MODEL=string|undefined             // Legacy fallback if AI_MODEL unset
WORKER_TIMEOUT=string (ms, default: 600000)
MAX_SELF_EDIT=1|undefined                  // Allow Max to edit its own code
```

### Config Object (singleton):
```typescript
export const config = {
  telegramBotToken: string | undefined,
  authorizedUserId: number | undefined,
  apiPort: number,
  aiProvider: AIProviderName,
  aiModel: string (getter/setter),      // Dynamic switching
  classifierModel: string,
  workerTimeoutMs: number,
  telegramEnabled: boolean,               // Derived: token && userId
  selfEditEnabled: boolean,                // Derived: MAX_SELF_EDIT === "1"
};
```

### Persistence:
```typescript
function persistEnvVar(key: string, value: string): void {
  // Update or append to ~/.max/.env (file operations)
}

export function persistModel(model: string): void {
  persistEnvVar("AI_MODEL", model);
}
```

---

## 8. Boot & Message Flow Sequence

### Boot Sequence:
```
max start
  ↓
cli.ts routes to daemon.ts main()
  ↓
1. Load config from ~/.max/.env
2. Initialize SQLite DB (~/.max/max.db)
3. Create/connect AI runtime client for configured provider
4. Init orchestrator:
   - Load MCP servers from ~/.copilot/mcp-config.json
   - Load skills from ~/.max/skills/, ~/.agents/skills/
   - Resume or create persistent orchestrator session
   - Inject recent conversation context if needed
   - Start 30s health check loop
5. Start Express API server (port 7777)
6. Start Telegram bot (if configured)
7. Wire up proactive notifications
8. Non-blocking update check
9. Ready for messages
```

### Message Flow (User sends message):

**Via Telegram**:
```
User sends message in Telegram
  ↓
grammy middleware (auth check)
  ↓
telegram/bot.ts handler
  ↓
sendToOrchestrator(prompt, { type: "telegram", chatId, messageId }, callback)
  ↓
[See orchestrator message flow below]
```

**Via TUI**:
```
User types in terminal (tui/index.ts)
  ↓
POST /send to local API (localhost:7777)
  ↓
api/server.ts handler
  ↓
sendToOrchestrator(prompt, { type: "tui", connectionId }, callback)
  ↓
[See orchestrator message flow below]
```

### Orchestrator Message Flow (core/orchestrator.ts):

```
sendToOrchestrator() called
  ↓
Log incoming message
  ↓
Enqueue message + callback to messageQueue
  ↓
processQueue() processes one-at-a-time (serialized):
  │
  ├─ resolveModel(): Intelligent model selection
  │  ├─ Check for keyword-based overrides (e.g., "design" → claude-opus)
  │  ├─ Classify message as fast/standard/premium via LLM (if router enabled)
  │  ├─ Look up tier → model mapping
  │  └─ Auto-switch if needed, destroy orchestrator session to recreate
  │
  ├─ executeOnSession():
  │  ├─ Ensure orchestrator session exists
  │  ├─ Subscribe to normalized runtime events (message.delta, tool.complete)
  │  ├─ Call session.sendAndWait(prompt, 300s timeout)
  │  ├─ Accumulate streamed deltas, call callback with partial text
  │  └─ Return final content or throw if session broken
  │
  ├─ Retry logic:
  │  ├─ Catch recoverable errors (timeout, disconnect, EPIPE, etc.)
  │  ├─ Retry up to 3 times with backoff (1s, 3s, 10s)
  │  ├─ Reset client before retry
  │  └─ Non-recoverable errors → fail immediately
  │
  └─ On success:
     ├─ Deliver response to callback (done: true)
     ├─ Log to message logger
     └─ Insert into conversation_log table
```

### Tool Execution (while session.sendAndWait running):

When orchestrator uses a tool:
```
Tool call received by session
  ↓
Tool handler in tools.ts:
  ├─ create_worker_session: spawn Copilot CLI in directory
  │  ├─ Create CopilotSession for that directory
  │  ├─ Store in workers Map
  │  ├─ If initial_prompt: send in background, return immediately
  │  └─ Return worker confirmation
  │
  ├─ send_to_worker: send prompt to existing worker
  │  ├─ Look up worker by name
  │  ├─ Call worker.session.sendAndWait() in background thread
  │  ├─ When complete: call onWorkerComplete callback
  │  └─ Return immediately ("task dispatched")
  │
  ├─ learn_skill: create skill in ~/.max/skills/
  │  ├─ Guard against path traversal
  │  ├─ Create SKILL.md with frontmatter
  │  ├─ Create _meta.json
  │  └─ Return confirmation
  │
  ├─ recall_memory, save_memory, forget_memory: SQLite operations
  │
  └─ Other tools: list_sessions, kill_session, etc.
```

### Background Worker Completion:

```
Worker session finishes
  ↓
feedBackgroundResult(workerName, result)
  ↓
Create system message: "[Background task completed] Worker '...' finished:\n\n{result}"
  ↓
sendToOrchestrator(systemMessage, { type: "background" }, callback)
  ↓
Orchestrator receives & processes (same flow as user message)
  ↓
If proactiveNotify set:
   ├─ If telegram channel: sendProactiveMessage(text) to Telegram
   └─ If tui channel: broadcastToSSE(text) to TUI subscribers
```

---

## 9. Data Persistence (store/db.ts)

### SQLite Database: ~/.max/max.db

**Tables**:

1. **worker_sessions**:
   - Metadata about long-running worker sessions
   - name (unique), copilot_session_id, working_dir, status, last_output, timestamps

2. **max_state** (Key-Value Store):
   - Persistent application state
   - Key examples:
     - `orchestrator_session_id`: Resumed on restart
     - `router_config`: Model routing overrides
     - Any arbitrary string keys

3. **conversation_log**:
   - Full audit trail of user ↔ assistant messages
   - role: 'user' | 'assistant' | 'system'
   - source: 'telegram' | 'tui' | 'unknown'
   - **Retention**: Last 200 entries only (pruned at startup + every 50 inserts)
   - **Purpose**: Context recovery if orchestrator session lost

4. **memories**:
   - Long-term knowledge extracted from conversations
   - category: 'preference' | 'fact' | 'project' | 'person' | 'routine'
   - source: 'user' (explicit) | 'auto' (extracted)
   - created_at, last_accessed timestamps
   - **Injected into system message as memory summary**

### Memory System:
```typescript
addMemory(category, content, source);      // Insert
searchMemories(keyword?, category?, limit); // Query + update last_accessed
removeMemory(id);                          // Delete
getMemorySummary();                        // Format for system message
```

---

## 10. Key Design Patterns

### 1. Message Serialization (single-threaded orchestrator):
- Message queue ensures only ONE message is processed at a time
- Prevents concurrent provider session state corruption
- Incoming messages queued if orchestrator busy
- Retries up to 3 times with exponential backoff

### 2. Session Lifecycle:
- **Persistent orchestrator**: Single session resumed across restarts
- **Worker sessions**: Temporary, spawned on-demand, destroyed when done
- **Health check**: Proactively reconnects client every 30s

### 3. Tool Callback Pattern:
```typescript
callback(textSoFar, done: boolean)
```
- Called incrementally as response streams in
- `done: false` during streaming
- `done: true` when complete
- Enables real-time UI updates in TUI/Telegram

### 4. Channel-Aware Processing:
- Messages tagged with source: `[via telegram]`, `[via tui]`, or `[via background]`
- Workers inherit originChannel to route completions back to caller
- Telegram messages formatted for mobile (short, no huge code blocks)
- TUI messages can be more verbose

### 5. Model Routing Intelligence:
- Keyword-based overrides (design task → premium model)
- LLM classification of message intent (fast vs standard vs premium)
- Configurable tier → model mapping
- Automatic session recreation when switching models

### 6. Skill Injection:
- SKILL.md content injected into system message at session creation time
- Skills are documentation, not code
- Max reads instructions and decides when/how to use them
- External tools (gog, curl, etc.) must be pre-installed on system

---

## 11. Key Files & Line Counts

| File | Lines | Purpose |
|------|-------|---------|
| src/tui/index.ts | 1,026 | Terminal UI with readline, SSE events, command parsing |
| src/copilot/tools.ts | 576 | Worker creation, skill mgmt, memory tools |
| src/copilot/orchestrator.ts | 441 | Persistent session, message queue, retries |
| src/api/server.ts | 281 | Express routes, bearer token auth |
| src/telegram/bot.ts | 244 | grammy bot, command handlers, auth |
| src/store/db.ts | 208 | SQLite schema, queries |
| src/copilot/router.ts | 201 | Model classification & selection |
| src/copilot/skills.ts | 150 | Skill discovery, creation, removal |
| src/copilot/system-message.ts | 139 | Orchestrator system prompt |

---

## 12. Deployment Model

- **Single daemon process**: Persistent `max start`
- **Clients connect to daemon**: TUI (local SSE), Telegram (remote bot)
- **No database sync**: SQLite is local only
- **No cloud**: All data stays on user's machine
- **Provider dependency**: With `AI_PROVIDER=copilot`, Copilot CLI must be available (auto-started by runtime)

---

## Summary

Max is a sophisticated AI orchestrator that:
1. **Boots** by loading config, initializing SDK client, resuming persistent orchestrator session
2. **Accepts messages** from 3 channels (Telegram, TUI, background)
3. **Routes intelligently** by classifying task complexity and selecting appropriate model
4. **Delegates tasks** by spawning worker Copilot sessions in specific directories
5. **Learns continuously** via skill system (documentation-based tool integration)
6. **Remembers context** via conversation log and long-term memory
7. **Stays healthy** via periodic health checks and graceful reconnection
8. **Scales safely** via message queue serialization and worker limits (max 5 concurrent)

All configuration, state, skills, and conversation history live in ~/.max/ (portable, user-scoped).
