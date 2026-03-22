# Max Boot & Message Flow Sequence Diagrams

## Full Boot Sequence (`max start`)

```
┌─ User runs: max start ─────────────────────────────────────────┐
│                                                                 │
│  cli.ts parses args → routes to daemon.ts                      │
│                                                                 │
└─────────────────┬───────────────────────────────────────────────┘
                  │
                  ▼
          ┌─────────────────┐
          │  daemon.ts      │
          │  main() {        │
          └────────┬────────┘
                   │
        ┌──────────┼──────────┐
        │          │          │
        ▼          ▼          ▼
   ┌────────┐ ┌─────────┐ ┌──────┐
   │config  │ │database │ │client│
   │.ts     │ │.ts      │ │.ts   │
   └────┬───┘ └────┬────┘ └──┬───┘
        │          │         │
        │          │      getClient()
        │      getDb()    ▼
        │      ▼     Start SDK
        │    SQLite  autoStart:true
        │    Create   autoRestart
        │    tables   ▼
        │           Connected
        │
        └────────────┬────────────┐
                     │            │
                     ▼            ▼
            ┌─────────────────────────────────────┐
            │  initOrchestrator(client)           │
            │  orchestrator.ts                    │
            └─────────────────────────────────────┘
                     │
        ┌────────────┼────────────────────────────┐
        │            │                            │
        ▼            ▼                            ▼
    ┌─────────┐  ┌──────────┐  ┌──────────────────────┐
    │Load MCP │  │Load Skills   │Validate Model    │
    │from:    │  │from:         │Against Available │
    │~/.copilot   │~/.max/skills │models from SDK  │
    │mcp-config   │~/.agents     │                  │
    │.json        │(bundled)     │Fallback to      │
    │            │              │DEFAULT_MODEL    │
    └─────────┘  └──────────────┘  └──────────────┘
        │            │                   │
        └────────────┼───────────────────┘
                     │
                     ▼
        ┌─────────────────────────────────────┐
        │ Try Resume Orchestrator Session     │
        │ ─────────────────────────────────   │
        │ 1. Get saved session ID from state  │
        │ 2. If found, call                   │
        │    client.resumeSession(id, {      │
        │      model, configDir, streaming,  │
        │      systemMessage, tools,         │
        │      mcpServers, skillDirs,        │
        │      onPermissionRequest: approveAll│
        │    })                              │
        │ 3. If failed: create fresh session │
        │ 4. Inject recent conversation      │
        │    context if session was lost     │
        └──────────┬──────────────────────────┘
                   │
                   ▼
        ┌─────────────────────────────────┐
        │ Set orchestratorSession ref     │
        │ Save session.sessionId to state │
        │ Start 30s health check loop     │
        │ Return to main()                │
        └─────────────────────────────────┘
                   │
        ┌──────────┼───────────┐
        │          │           │
        ▼          ▼           ▼
    ┌────────┐ ┌────────┐ ┌──────────┐
    │Start   │ │Create  │ │Proactive │
    │Express │ │Telegram│ │Notify    │
    │Server  │ │Bot     │ └──────────┘
    │:7777   │ │(if cfg)│
    └────────┘ └────────┘
        │          │
        └──────────┼──────────┐
                   │          │
                   ▼          ▼
            ┌────────────────────┐
            │  Non-blocking      │
            │  Update Check      │
            │  (background)      │
            └────────────────────┘
                   │
                   ▼
        ┌─────────────────────────┐
        │ ✅ Max Fully Operational│
        │ Ready for messages      │
        └─────────────────────────┘
```

---

## Message Processing Pipeline

### Incoming Message (Any Source)

```
┌─ Telegram Message ───────────────┐
│ grammy bot receives text from    │
│ authorized user (via middleware) │
└────────────────────┬─────────────┘
                     │
         ┌───────────┴────────────┐
         │                        │
         ▼                        ▼
┌──────────────────┐   ┌──────────────────────┐
│  TUI Input       │   │  Background Result   │
│  POST /send      │   │  [task completed]    │
│  (HTTP API)      │   │  message from worker │
└────────┬─────────┘   └──────────┬───────────┘
         │                        │
         └────────────┬───────────┘
                      │
                      ▼
        ┌──────────────────────────────┐
        │  sendToOrchestrator(        │
        │    prompt,                  │
        │    source,                  │
        │    callback                 │
        │  )                          │
        │  orchestrator.ts            │
        └──────────────┬───────────────┘
                       │
                       ▼
            ┌──────────────────────────┐
            │  Log to message logger   │
            │  (console output)        │
            └──────────────┬───────────┘
                           │
                           ▼
            ┌──────────────────────────┐
            │  Add channel tag:        │
            │  [via telegram]          │
            │  [via tui]               │
            │  [via background]        │
            │  ─────────────────────   │
            │  Enqueue message:        │
            │  {                       │
            │    prompt,               │
            │    callback,             │
            │    sourceChannel,        │
            │    resolve,              │
            │    reject                │
            │  }                       │
            └──────────────┬───────────┘
                           │
                           ▼
            ┌──────────────────────────┐
            │  processQueue()          │
            │  (serialized, one at a   │
            │   time)                  │
            └──────────────┬───────────┘
                           │
                           ▼
                ┌──────────────────────┐
                │ resolveModel()       │
                │ ─────────────────    │
                │ Check keyword       │
                │ overrides           │
                │ ↓                   │
                │ Classify message    │
                │ (LLM if enabled)    │
                │ ↓                   │
                │ Map tier→model      │
                │ ↓                   │
                │ If switching:       │
                │  - Set new model    │
                │  - Destroy session  │
                └────────┬────────────┘
                         │
                         ▼
            ┌──────────────────────────┐
            │  executeOnSession()      │
            │  ─────────────────────   │
            │  Ensure orchestrator    │
            │  session exists         │
            │  ↓                      │
            │  Subscribe to events:  │
            │  - message_delta       │
            │  - tool.exec_complete  │
            │  ↓                      │
            │  Call session.         │
            │  sendAndWait(prompt)   │
            │  ↓                      │
            │  Stream responses       │
            │  (accumulate deltas)    │
            │  ↓                      │
            │  Callback(partial, ✗)   │
            │  Callback(full, ✓)      │
            └────────┬────────────────┘
                     │
        ┌────────────┼─────────────┐
        │            │             │
        ▼            ▼             ▼
    ┌─────┐    ┌──────┐    ┌─────────────┐
    │Tool │    │Tool  │    │ (more tools)
    │Call │    │Call  │
    │Ex.  │    │Ex.   │
    │1    │    │2     │
    └──┬──┘    └──┬───┘    └─────────────┘
       │          │
       └─────┬────┘
             │
             ▼
    ┌─────────────────────┐
    │ Tool Handler        │
    │ (in tools.ts)       │
    │ ─────────────────   │
    │ create_worker_session
    │ send_to_worker      │
    │ learn_skill         │
    │ recall_memory       │
    │ save_memory         │
    │ etc.                │
    └────────┬────────────┘
             │
             ▼
    ┌─────────────────────┐
    │ Return tool result  │
    │ immediately         │
    │ (non-blocking)      │
    └──────────┬──────────┘
               │
    (Session continues to execute, tool returns immediately)
               │
               ▼
        ┌─────────────────────────┐
        │  Accumulate final       │
        │  response text          │
        │  ↓                      │
        │  Return from            │
        │  session.sendAndWait()  │
        └──────────┬──────────────┘
                   │
    ┌──────────────┼──────────────┐
    │              │              │
    ▼              ▼              ▼
┌──────────┐  ┌──────────┐  ┌──────────┐
│Success   │  │Timeout   │  │Disconnect
│─────────    │─────────    │──────────
│Deliver   │  │Retry     │  │Reset SDK
│response  │  │(backoff) │  │Retry
│to user   │  └──────────┘  └──────────┘
│(done✓)   │
└──────────┘
```

---

## Worker Session Lifecycle

### When Orchestrator Creates Worker:

```
Orchestrator receives message requesting work:
  "Start working on the bug in ~/dev/app"

        │
        ▼

Orchestrator calls create_worker_session tool:
{
  name: "app-bug",
  working_dir: "/Users/user/dev/app",
  initial_prompt: "Find and fix the null pointer..."
}

        │
        ▼

Tool handler checks:
  ✓ Worker doesn't already exist
  ✓ Not too many workers running (max 5)
  ✓ Path not in blocked dirs (~/.ssh, etc)

        │
        ▼

Create CopilotSession:
  await client.createSession({
    model,
    configDir: ~/.max/sessions,
    tools: [...],
    mcpServers: {...},
    skillDirectories: [...]
  })

        │
        ▼

Store in workers Map:
{
  name: "app-bug",
  session: CopilotSession,
  workingDir: "/Users/user/dev/app",
  status: "idle" | "running",
  originChannel: "telegram" | "tui"
}

        │
        ▼

Return immediately to orchestrator:
"Worker 'app-bug' created. Sending task..."

        │
        ▼

If initial_prompt provided:
  (run in background, don't wait)
  worker.session.sendAndWait(initial_prompt, timeout)
    ↓
  When complete:
    onWorkerComplete("app-bug", result)
    ↓
    Feed result back to orchestrator as background message
    ↓
    Orchestrator sends to user: "Bug fixed! Here's what I found..."

        │
        ▼

When done or user kills worker:
  Call worker.session.destroy()
  Remove from workers Map
```

---

## Proactive Notification (Background → User)

```
Worker completes task:
"Fixed the null pointer on line 42"

        │
        ▼

onWorkerComplete callback invoked:
feedBackgroundResult("app-bug", result)

        │
        ▼

Craft background message:
"[Background task completed] Worker 'app-bug' finished:
Fixed the null pointer on line 42"

        │
        ▼

sendToOrchestrator(bgMsg, { type: "background" }, callback)

        │
        ▼

Orchestrator processes as system message
(routes back to originating channel)

        │
        ├─ If originChannel = "telegram":
        │  └─ sendProactiveMessage(text) → Telegram user
        │
        └─ If originChannel = "tui":
           └─ broadcastToSSE(text) → TUI subscribers
```

---

## MCP Server Integration

```
At orchestrator init:

loadMcpConfig()
  ↓
Read ~/.copilot/mcp-config.json
  ↓
Parse mcpServers section
  ↓
Return Record<string, MCPServerConfig>

        │
        ▼

Pass to createSession():
await client.createSession({
  mcpServers: { 
    "git": { ... },
    "database": { ... }
  },
  ...
})

        │
        ▼

Copilot SDK loads MCP servers
(negotiates tool discovery, etc.)

        │
        ▼

MCP tools become available in:
  - Orchestrator session
  - All worker sessions
  - System message tools list

        │
        ▼

When orchestrator/worker needs an MCP tool:
Session calls tool handler
SDK communicates via MCP protocol
Tool result returns to session
```

---

## State Recovery (Orchestrator Crash)

```
Max daemon crashes or Copilot SDK disconnects

        │
        ▼

User sends new message

        │
        ▼

sendToOrchestrator() called

        │
        ▼

ensureOrchestratorSession():
  orchestratorSession = undefined
  ↓
  Try get saved session ID from max_state
  ↓
  Call client.resumeSession(savedId, config)
  ↓
  If resumption fails: create fresh session
  
        │
        ▼

If session was lost (fresh session):
  Query conversation_log:
    SELECT * FROM conversation_log
    WHERE id > (now - 200 entries)
    ORDER BY id DESC
  ↓
  Format recent history
  ↓
  Send system message:
    "[System: Session recovered]
     Here's recent context for reference:
     [user]: ...
     [max]: ...
     (do NOT respond to these, absorb silently)"
  ↓
  Wait for session to absorb (60s timeout)

        │
        ▼

New orchestrator session ready
Current user message processes normally
```

---

## Clean Shutdown Sequence

```
User presses Ctrl+C

        │
        ▼

SIGINT / SIGTERM handler

        │
        ├─ Check active workers
        │
        ├─ If workers running (first Ctrl+C):
        │  └─ Warn user, wait for them to press Ctrl+C again
        │
        ├─ Second Ctrl+C or no workers:
        │  │
        │  ├─ Set 3s force timeout
        │  │
        │  ├─ Stop Telegram bot
        │  │
        │  ├─ Destroy all worker sessions
        │  │    await Promise.allSettled(
        │  │      workers.map(w => w.session.destroy())
        │  │    )
        │  │
        │  ├─ Stop Copilot SDK client
        │  │
        │  ├─ Close SQLite database
        │  │
        │  └─ Exit(0)
        │
        └─ If force timeout expires: Exit(1)
```
