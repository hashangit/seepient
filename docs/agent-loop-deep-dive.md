# The Agent Loop Deep Dive

How middleware, hooks, skills, and session store work inside the agent loop — traced line by line from actual source code.

---

## The Big Picture: Who Lives Where

Not all four systems run at the same level.

```
runAgentLoop()                           ← entry point
│
├── MIDDLEWARE (wraps the ENTIRE loop)   ← runs BEFORE the loop starts
│   └── executeLoop()                    ← the actual loop
│       ├── SKILLS (injected into system prompt)  ← runs ONCE before iteration
│       ├── for (step = 0; step < maxSteps)       ← the iteration
│       │   ├── HOOKS (fire at specific moments)  ← runs INSIDE each iteration
│       │   ├── Provider call
│       │   ├── Tool execution
│       │   └── HOOKS (again, after tool)
│       └── return result
│
└── SESSION STORE (called by ADAPTER)    ← runs AFTER the loop finishes
```

Middleware is the **outermost wrapper**. Skills are **system prompt content**. Hooks are **event listeners inside the loop**. Session store is **persistence called by the adapter** — it's not inside the loop at all.

---

## Step 1: Something Calls `runAgentLoop()`

**File:** `src/core/agent-loop.ts:75`

An adapter (CLI, SDK, or Server) calls `runAgentLoop(options)` with everything it knows:

```ts
// Example: SDK's createAgent.chat() calling the loop
const result = await runAgentLoop({
  provider: llmProvider,     // which brain company to use
  model: "gpt-4o",          // which model
  messages: [...],           // conversation history so far
  toolDefs: [...],           // available tools
  systemPrompt: "...",       // the robot's personality
  skillCatalog: "...",       // skill list (from buildSkillCatalog)
  maxSteps: 10,              // safety limit
  hooks: hookExecutor,       // event listeners
  middleware: [...],         // conveyor belt inspectors
  signal: abortController.signal,  // kill switch
  approveTool: fn,           // tool approval callback
  permissionLevel: "moderate",
});
```

---

## Step 2: Middleware — The Conveyor Belt Inspectors

**File:** `src/core/middleware.ts:75-161`

The first thing `runAgentLoop` does is check: **did anyone provide middleware?**

```ts
// agent-loop.ts:94
if (!middleware || middleware.length === 0) {
  return executeLoop(options);  // no inspectors? go straight to work
}
```

If middleware **is** provided, it builds a **pipeline context** — a big box of information that every inspector can read and modify:

```ts
// agent-loop.ts:99-108
const ctx: PipelineContext = {
  requestId: "abc-123",    // unique ID for this request
  messages: [...],          // the conversation (inspectors CAN modify this!)
  provider: llmProvider,    // the brain
  model: "gpt-4o",         // the model
  toolDefs: [...],          // available tools
  metadata: {...},          // who called, from where, etc.
  signal: AbortSignal,      // kill switch
  startedAt: Date.now(),    // when did this start?
  result: undefined,        // will be filled AFTER the loop runs
};
```

Then it calls `compose(middleware)` — this chains the middleware into an **onion**:

```
┌─ authMiddleware ──────────────────────────────────────────┐
│  "Is this person allowed in?"                              │
│  ┌─ rateLimitMiddleware ─────────────────────────────────┐ │
│  │  "Have they sent too many requests?"                   │ │
│  │  ┌─ loggingMiddleware ───────────────────────────────┐ │ │
│  │  │  "Log that we're starting"                         │ │ │
│  │  │  ┌─ FINAL HANDLER (the actual loop) ───────────┐  │ │ │
│  │  │  │  executeLoop(options)                        │  │ │ │
│  │  │  │  → fills ctx.result                         │  │ │ │
│  │  │  └─────────────────────────────────────────────┘  │ │ │
│  │  │  "Log that we finished, how long it took"         │ │ │
│  │  └───────────────────────────────────────────────────┘ │ │
│  └────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────┘
```

Each middleware gets `(ctx, next)`. It can:
- **Inspect `ctx`** before calling `next()` — look at messages, model, metadata
- **Modify `ctx`** — change messages, add metadata, etc.
- **Throw** to **stop the entire request** (auth rejection, rate limit exceeded)
- **Call `next()`** to pass control to the next middleware
- **Inspect `ctx.result`** after `next()` returns — see what the loop produced

### The 3 Built-in Middleware

#### Auth (`src/core/middleware/auth.ts`)

The bouncer at the door.

```ts
const allowed = await validate(ctx);
if (!allowed) throw new SeepientError("Unauthorized", "UNAUTHORIZED", false);
// If thrown, the loop NEVER RUNS. agent-loop.ts catches it and returns
// finishReason: "error" with code "UNAUTHORIZED"
await next();  // passed the check? let the next inspector run
```

#### Rate Limit (`src/core/middleware/rate-limit.ts`)

The ticket counter. Uses a token bucket algorithm — you get N requests per time window.

```ts
if (bucket.tokens <= 0) throw new SeepientError("Rate limit exceeded", ...);
bucket.tokens -= 1;   // use a ticket
await next();         // still have tickets? continue
```

Buckets are tracked per key. By default it's "global" (one bucket for everyone), but you can extract a key from context:

```ts
keyExtractor: (ctx) => ctx.metadata.userId as string  // per-user limiting
```

#### Logging (`src/core/middleware/logging.ts`)

The stenographer. Logs structured lines before and after the loop runs.

```ts
// BEFORE next():
[seepient] request=abc-123 model=gpt-4o messages=5 start

await next();

// AFTER next():
[seepient] request=abc-123 model=gpt-4o finish=stop steps=3 tokens=850 duration=2340ms
```

### What Happens When Middleware Throws

**File:** `src/core/agent-loop.ts:146-165`

If ANY middleware throws, the loop **never runs**. The error is caught and returned as a structured result — it's not a crash. Since v0.2.2, middleware errors are also logged to `console.error` for audit trail:

```ts
catch (err) {
  // Log the error for audit trail even though middleware chain was interrupted
  console.error(`[middleware] request ${ctx.requestId} failed after ${Date.now() - ctx.startedAt}ms:`,
    err instanceof Error ? err.message : String(err));

  return {
    messages,
    steps: [],
    toolCalls: [],
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0 },
    finishReason: "error",
    error: {
      message: err.message,
      code: err.code ?? "MIDDLEWARE_ERROR",
      retryable: false,
    },
  };
}
```

---

## Step 3: Skills — The Instruction Booklet in the System Prompt

**File:** `src/core/skill-catalog.ts` + `agent-loop.ts:189-201`

Once we're past middleware and inside `executeLoop`, the very first thing that happens is **system prompt setup**:

```ts
// agent-loop.ts:189-196
// If there's no system message yet, prepend one
if (systemPrompt && messages[0].role !== "system") {
  messages.unshift({ role: "system", content: systemPrompt });
}
```

Then **skills get injected** into that system message:

```ts
// agent-loop.ts:199-201
if (skillCatalog && messages[0].role === "system") {
  messages[0].content += '\n\n' + skillCatalog;
}
```

The `skillCatalog` string was built by `buildSkillCatalog()` which takes all discovered skills and turns them into text:

```
AVAILABLE SKILLS (activate with use_skill tool):
- summarize: Condenses long text into bullet points [writing, nlp]
- translate: Translates text between languages [language]
- code-review: Reviews code for bugs and improvements [development]
When a user request matches a skill, call use_skill with the skill name.
```

**Skills are not code that runs.** They are **text instructions stuffed into the system prompt.** The LLM reads them and decides "oh, the user wants a translation, I should call the `use_skill` tool." Then when the loop reaches tool execution, `use_skill` loads and runs the actual skill file.

**The skill activation flow:**

1. Skills discovered from disk → parsed → metadata collected
2. `buildSkillCatalog(metadata)` → generates text string
3. Text appended to system message → LLM sees it
4. LLM decides to use a skill → calls `use_skill` tool
5. Tool executor loads the skill file → executes it

---

## Step 4: The Loop Iteration — Where Hooks Live

**File:** `src/core/agent-loop.ts:219-428`

Now the actual `for` loop begins. Each iteration follows this exact sequence:

```
for each step (0 to maxSteps):
  1. Check abort signal          ──── did someone say STOP?
  2. Resolve provider            ──── which brain am I using this step?
  3. Convert messages            ──── translate to provider format
  4. Call provider.chat()        ──── ask the brain
  5. Process text response       ──── brain said words
     → HOOK: onStep(textStep)    ←─── hooks fire HERE
  6. Process tool calls          ──── brain said "use this tool"
     → HOOK: beforeToolCall()    ←─── hooks fire BEFORE tool runs
     → Permission check          ──── is this tool allowed?
     → Execute tool              ──── actually run it
     → HOOK: afterToolCall()     ←─── hooks fire AFTER tool runs
     → HOOK: onStep(toolStep)    ←─── hooks fire HERE too
  7. If tool calls existed → continue loop (go back to step 1)
  8. If no tool calls → we're done, break
```

### Where Exactly Each Hook Fires

#### `beforeToolCall` — fires right before a tool executes

```ts
// agent-loop.ts:332
await hooks.beforeToolCall({ name: tc.name, args: parsedArgs });
// THEN the permission check + execution happens
```

#### `onStep` — fires twice: once for text, once for tool results

```ts
// agent-loop.ts:286 — when the LLM sends text back
await hooks.onStep(textStep);

// agent-loop.ts:405 — when a tool finishes executing
await hooks.onStep(toolStep);
```

#### `afterToolCall` — fires right after a tool finishes

```ts
// agent-loop.ts:406
await hooks.afterToolCall({ name: tc.name, output, duration });
```

#### `onError` — fires when the provider crashes or provider resolution fails

```ts
// agent-loop.ts:246 — provider factory fails
await hooks.onError(seepientErr);

// agent-loop.ts:267 — provider.chat() throws
await hooks.onError(seepientErr);
```

#### `onFinish` — called by the adapter, not the loop

This is defined in `HookExecutor` but **never called inside the loop**. The adapter calls it after getting the result back. This is an adapter-level hook, not a loop-level one.

### Provider Factory Restore

**File:** `src/core/agent-loop.ts:220-428`

When a skill switches the active provider via `switchProvider()`, the original provider is restored after each loop step. As of v0.2.2, this restore runs in a `finally` block, so it executes on **every exit path** — including text-only completion, errors, and aborts — preventing provider state from leaking into subsequent agent runs.

```ts
for (let step = 0; step < maxSteps; step++) {
  try {
    // ... loop body ...
  } finally {
    if (providerFactory) providerFactory.restore();
  }
}
```

### What Makes Hooks Special: The Safety Wrapper

**File:** `src/core/hooks.ts:43-53`

Every hook goes through this safety wrapper:

```ts
async function run(fn, label) {
  if (fn == null) return;         // no hook? skip silently
  try {
    await fn();                    // run the hook
  } catch (err) {
    console.error(`[seepient] ${label} hook error:`, err);
    // ⚠️ ERROR IS SWALLOWED — the loop continues!
  }
}
```

**A broken hook can NEVER crash the agent loop.** If your `beforeToolCall` hook throws, the tool still executes. If your `onStep` hook throws, the loop keeps going. The error is logged and forgotten.

---

## Step 5: Session Store — The Memory Box (Called by Adapters)

**File:** `src/core/session-store.ts`

The session store has nothing to do with the agent loop. The loop doesn't know about persistence. It just returns `AgentLoopResult` and goes home.

The **adapter** (SDK, CLI) is responsible for calling the session store. Here's how the SDK's `createAgent` does it:

```ts
// src/adapters/sdk/agent.ts — inside chat()
const result = await runAgentLoop({...});  // loop runs
await persistMessages();                    // THEN save to disk
```

And `persistMessages()` calls the session store:

```ts
// src/adapters/sdk/agent.ts
async function persistMessages() {
  if (backend) {
    await backend.save(sessionId, {
      id: sessionId,
      messages,
      createdAt: messages[0]?.timestamp ?? Date.now(),
      updatedAt: Date.now(),
    });
  }
}
```

### The Session Store Architecture

Factory + registry pattern:

```
createPersistenceBackend({ type: "file", path: "~/.seepient/sessions" })
       │
       ▼
  Registry lookup: "file" → FilePersistenceBackend
       │
       ▼
  FilePersistenceBackend
    ├── save(id, SessionData)  → writes ~/.seepient/sessions/{id}.json
    ├── load(id)               → reads the file, parses JSON
    ├── delete(id)             → deletes the file
    └── list()                 → lists all .json files in directory
```

#### Two Built-in Backends

- **File** (`FilePersistenceBackend`): Each session = one JSON file on disk. Written to `~/.seepient/sessions/` by default, or any path you provide.
- **Memory** (`MemoryPersistenceBackend`): Each session = one entry in a `Map`. Vanishes on restart. Useful for testing.

#### Custom Backends

```ts
registerBackend("redis", (config) => new RedisPersistenceBackend(config));
registerBackend("sqlite", (config) => new SQLitePersistenceBackend(config));
```

### What Gets Saved

```ts
SessionData = {
  id: "session-abc-123",
  messages: [...],           // the full conversation history
  createdAt: 1718000000000,
  updatedAt: 1718000001000,
  provider: "openai",        // optional
  model: "gpt-4o",           // optional
  metadata: {...},           // optional
}
```

When `save()` is called, it **merges** with existing data — it preserves `createdAt` from the existing file and updates `updatedAt` to now. Repeated saves don't destroy the original creation timestamp.

::: tip Atomic writes (v0.2.2+)
`FilePersistenceBackend.save()` writes to a temporary file first, then renames it to the target path. This ensures a crash mid-write never leaves a corrupt session file on disk.
:::

---

## The Complete Timeline — All Systems Together

A real request traced end-to-end. User says "Summarize this document" via the SDK:

```
 TIME   │  SYSTEM       │  WHAT HAPPENS
────────┼───────────────┼──────────────────────────────────────────────────
 T+0ms  │  SDK Adapter  │  chat("Summarize this document") called
        │               │  → user message added to messages[]
        │               │  → runAgentLoop() called with hooks, middleware, etc.
        │               │
 T+1ms  │  MIDDLEWARE   │  compose([auth, rateLimit, logging])(ctx, finalHandler)
        │               │  → auth: checks ctx.metadata.apiKey ✓
        │               │  → rateLimit: bucket has tokens left ✓
        │               │  → logging: logs "request=abc start"
        │               │
 T+2ms  │  EXECUTE LOOP │  System prompt prepended
        │               │  Skill catalog appended to system prompt:
        │               │    "AVAILABLE SKILLS: - summarize: ..."
        │               │
 T+3ms  │  LOOP STEP 0  │  Convert messages → provider format
 T+4ms  │  PROVIDER     │  provider.chat(messages, tools, {signal})
        │               │  → sends to OpenAI/Anthropic/GLM
        │               │
 T+5s   │  RESPONSE     │  Provider responds: text="" + tool_call: use_skill("summarize")
        │               │
 T+5s   │  HOOKS        │  hooks.onStep(textStep)        ← fires (empty text)
 T+5s   │  HOOKS        │  hooks.beforeToolCall({name: "use_skill", args: ...})
 T+5.1s │  PERMISSIONS  │  checkToolPermission("moderate", riskCategory) → "ask"
 T+5.1s │  APPROVAL     │  approveTool({name: "use_skill"}) → true
 T+5.2s │  TOOL EXEC    │  executeTool("use_skill", args) → loads skill file, runs it
 T+5.5s │  HOOKS        │  hooks.afterToolCall({name: "use_skill", output: "...", duration: 300})
 T+5.5s │  HOOKS        │  hooks.onStep(toolStep)
        │               │  → Tool result added to messages[]
        │               │  → continue loop (there were tool calls)
        │               │
 T+5.6s │  LOOP STEP 1  │  Convert updated messages → provider format
 T+5.7s │  PROVIDER     │  provider.chat(messages, tools, {signal})
        │               │
 T+8s   │  RESPONSE     │  Provider responds: text="Here's the summary: ..." (no tool calls)
        │               │
 T+8s   │  HOOKS        │  hooks.onStep(textStep)        ← fires with summary text
        │               │  → No tool calls → finishReason = "stop" → break
        │               │
 T+8.1s │  LOOP RETURNS │  { messages, steps, toolCalls, usage, finishReason: "stop" }
        │               │
 T+8.1s │  MIDDLEWARE   │  logging: logs "request=abc finish=stop steps=2 tokens=850 duration=8100ms"
        │               │
 T+8.2s │  SDK Adapter  │  persistMessages() called
        │  SESSION      │  backend.save(sessionId, { messages, createdAt, updatedAt })
        │  STORE        │  → writes ~/.seepient/sessions/session-abc-123.json
        │               │
 T+8.3s │  DONE         │  Returns { text: "Here's the summary: ...", toolCalls: [...], usage: {...} }
```

---

## Summary: What Each System Actually Does

| System | When it runs | What it does | Can it stop the loop? |
|--------|-------------|--------------|----------------------|
| **Middleware** | Before the loop starts | Inspects/modifies the request context. Auth, rate limiting, logging. | **Yes** — by throwing |
| **Skills** | Once, before iteration 0 | Injects skill descriptions into the system prompt as text | No — it's just text |
| **Hooks** | At specific points inside each loop iteration | Fires events: before/after tools, on each step, on errors | **No** — errors are swallowed |
| **Session Store** | After the loop finishes (called by adapter) | Saves/loads conversation history to disk or memory | No — it's post-loop cleanup |

The power is in how they compose: middleware **guards the gate**, skills **teach the LLM what it can do**, hooks **observe without disrupting**, and session store **remembers for next time**.

---

## Source Files Reference

| System | File | Key exports |
|--------|------|-------------|
| Agent loop | `src/core/agent-loop.ts` | `runAgentLoop()`, `executeLoop()`, `AgentLoopOptions`, `AgentLoopResult` |
| Middleware | `src/core/middleware.ts` | `PipelineContext`, `Middleware` type, `compose()` |
| Auth middleware | `src/core/middleware/auth.ts` | `authMiddleware()` |
| Rate limit middleware | `src/core/middleware/rate-limit.ts` | `rateLimitMiddleware()` |
| Logging middleware | `src/core/middleware/logging.ts` | `loggingMiddleware()` |
| Hooks | `src/core/hooks.ts` | `createHookExecutor()`, `HookExecutor` |
| Skill catalog | `src/core/skill-catalog.ts` | `buildSkillCatalog()` |
| Session store | `src/core/session-store.ts` | `FilePersistenceBackend`, `MemoryPersistenceBackend`, `createPersistenceBackend()`, `registerBackend()` |
| SDK adapter | `src/adapters/sdk/agent.ts` | `createAgent()` — shows how adapter wires loop + session store together |
