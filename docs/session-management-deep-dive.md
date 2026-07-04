# The Session Management Deep Dive

How session persistence, pluggable backends, and adapter-specific session handling work across the SDK, CLI, and Server — traced line by line from actual source code.

---

## The Big Picture: Three Layers, Three Behaviors

Session management is not one system — it's **three different strategies** sharing a common persistence layer:

```
┌─────────────────────────────────────────────────────────────┐
│                    PERSISTENCE LAYER                        │
│  PersistenceBackend interface (file, memory, custom)        │
│  Core types: SessionData, PersistenceConfig                 │
└──────────┬──────────────┬───────────────┬───────────────────┘
           │              │               │
    ┌──────▼──────┐ ┌─────▼─────┐ ┌───────▼──────────┐
    │  SDK Agent  │ │  CLI REPL │ │ Server Session   │
    │             │ │           │ │ Manager          │
    │ Backend     │ │ No persist│ │                  │
    │ persists    │ │ ephemeral │ │ TTL + limits +   │
    │ directly    │ │ in-memory │ │ cleanup on top   │
    └─────────────┘ └───────────┘ └──────────────────┘
```

The **SDK** gives you direct backend access. The **CLI** uses no persistence at all. The **Server** wraps a backend with TTL expiration, per-key concurrency limits, and periodic cleanup.

---

## 1. Core Types — The Contracts

**File:** `src/core/types.ts`

### SessionData — The Canonical Shape

Every session in the system is a `SessionData` object:

```ts
interface SessionData {
  id: string;                    // unique identifier (alphanumeric + dashes only)
  messages: Message[];           // full conversation history
  createdAt: number;             // epoch ms — preserved on overwrite
  updatedAt: number;             // epoch ms — updated on every save
  provider?: ProviderType;       // which LLM provider (openai, anthropic, etc.)
  model?: string;                // which model (gpt-4o, claude-3.5-sonnet, etc.)
  metadata?: Record<string, unknown>;  // extensible bag — server uses this for apiKeyHash, lastActivityAt
}
```

The `metadata` field is the escape hatch. The core layer never reads it. The server stores `apiKeyHash` and `lastActivityAt` there. Custom backends can store anything.

### PersistenceBackend — The Interface

```ts
interface PersistenceBackend {
  __persistenceBackend: true;  // brand discriminator — distinguishes from legacy SessionStore
  save(id: string, data: SessionData): Promise<void>;
  load(id: string): Promise<SessionData | null>;
  delete(id: string): Promise<void>;
  list(): Promise<string[]>;
}
```

Four methods. That's it. Any storage system that can do these four things can be a backend.

### PersistenceConfig — The Factory Input

```ts
interface PersistenceConfig {
  type: string;             // "file", "memory", "redis", "sqlite", etc.
  [key: string]: unknown;   // backend-specific options (path, url, etc.)
}
```

### SessionStore — The Deprecated Legacy

```ts
interface SessionStore {
  save(sessionId: string, messages: Message[]): Promise<void>;
  load(sessionId: string): Promise<Message[] | null>;
  delete(sessionId: string): Promise<void>;
  list(): Promise<string[]>;  // added later, not on original interface
}
```

Old API — saves only `Message[]`, not full `SessionData`. Still works via an adapter. If you encounter this in existing code, it's being wrapped automatically.

---

## 2. Core Persistence — The Backends

**File:** `src/core/session-store.ts`

### Built-in Backends

| Backend | Class | Storage | Default Path |
|---------|-------|---------|-------------|
| `"file"` | `FilePersistenceBackend` | JSON files on disk | `~/.seepient/sessions/{id}.json` |
| `"memory"` | `MemoryPersistenceBackend` | In-process `Map` | N/A (testing) |

### FilePersistenceBackend — The Production Backend

Each session is one JSON file. Here's the full lifecycle:

#### Save — Atomic Write with Merge

```ts
async save(id: string, data: SessionData): Promise<void> {
  validateSessionId(id);          // rejects "bad!id", accepts "abc-123"
  await this.ensureDir();         // mkdir -p on first write

  // Load existing data to preserve createdAt
  const existing = await this.loadFromDisk(id);
  const now = Date.now();

  const full: SessionData = existing
    ? {
        id,
        messages: data.messages,
        createdAt: existing.createdAt,   // ← PRESERVED from original
        updatedAt: now,                   // ← UPDATED to now
        provider: data.provider ?? existing.provider,
        model: data.model ?? existing.model,
        metadata: data.metadata ?? existing.metadata,
      }
    : {
        id,
        messages: data.messages,
        createdAt: now,       // first save — set both timestamps
        updatedAt: now,
        provider: data.provider,
        model: data.model,
        metadata: data.metadata,
      };

  // Atomic write: write to .tmp, then rename
  const filePath = this.filePath(id);
  const tmpPath = filePath + ".tmp." + Date.now();

  try {
    await fs.writeFile(tmpPath, JSON.stringify(full, null, 2), "utf-8");
    await fs.rename(tmpPath, filePath);      // atomic on most filesystems
  } catch (err) {
    try { await fs.unlink(tmpPath); } catch { /* best effort */ }
    throw err;
  }
}
```

Key behaviors:
- **Atomic writes**: writes to `{id}.json.tmp.{timestamp}` first, then renames. A crash mid-write never corrupts the session file.
- **Merge semantics**: `createdAt` from the existing file is preserved. Only `updatedAt` changes. `provider`, `model`, and `metadata` are merged with existing values (new values win if provided).
- **Session ID validation**: only `[a-zA-Z0-9-]` allowed. `"bad!id"` throws. `"my-session-01"` works.

#### Load — Read from Disk

```ts
async load(id: string): Promise<SessionData | null> {
  return this.loadFromDisk(id);   // read file, parse JSON, return or null
}
```

Returns `null` if the file doesn't exist or is unparseable. No errors thrown — silent failure.

#### Delete — Unlink File

```ts
async delete(id: string): Promise<void> {
  validateSessionId(id);
  try {
    await fs.unlink(this.filePath(id));
  } catch {
    // File doesn't exist — nothing to delete. Silent success.
  }
}
```

#### List — Scan Directory

```ts
async list(): Promise<string[]> {
  await this.ensureDir();
  const entries = await fs.readdir(this.basePath);
  return entries
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length));
}
```

Lists all `.json` files in the session directory, strips the extension. Returns session IDs.

### MemoryPersistenceBackend — The Test Backend

```ts
class MemoryPersistenceBackend implements PersistenceBackend {
  readonly __persistenceBackend = true as const;
  private store = new Map<string, SessionData>();

  async save(id: string, data: SessionData): Promise<void> {
    validateSessionId(id);
    const existing = this.store.get(id);
    const now = Date.now();

    this.store.set(id, {
      id,
      messages: data.messages,
      createdAt: existing?.createdAt ?? now,  // same merge behavior
      updatedAt: now,
      provider: data.provider ?? existing?.provider,
      model: data.model ?? existing?.model,
      metadata: data.metadata ?? existing?.metadata,
    });
  }

  async load(id: string): Promise<SessionData | null> {
    return this.store.get(id) ?? null;
  }

  async delete(id: string): Promise<void> {
    this.store.delete(id);
  }

  async list(): Promise<string[]> {
    return Array.from(this.store.keys());
  }
}
```

Same merge semantics, same interface, but in memory. Sessions vanish on process exit. Used in tests.

### The Factory / Registry

```ts
type BackendFactory = (config: PersistenceConfig) => PersistenceBackend;
const registry = new Map<string, BackendFactory>();

// Built-in registrations
registry.set("file", (config) => new FilePersistenceBackend(
  (config.path as string) ?? defaultSessionPath()
));
registry.set("memory", () => new MemoryPersistenceBackend());
```

Custom backends are registered at import time. The registry is a simple `Map`. Last write wins:

```ts
registerBackend("redis", (config) => new RedisPersistenceBackend(config));
registerBackend("sqlite", (config) => new SQLitePersistenceBackend(config));
```

Factory lookup:

```ts
function createPersistenceBackend(config: PersistenceConfig): PersistenceBackend {
  const factory = registry.get(config.type);
  if (!factory) {
    throw new Error(
      `Unknown persistence backend type "${config.type}". ` +
      `Registered types: ${Array.from(registry.keys()).join(", ")}`
    );
  }
  return factory(config);
}
```

Throws on unknown type. No fallback — explicit is better than implicit.

### Legacy API — The Adapters

The deprecated `SessionStore` interface is auto-wrapped via `wrapAsPersistenceBackend()` in the SDK:

```ts
function wrapAsPersistenceBackend(store: SessionStore | PersistenceBackend): PersistenceBackend {
  // If it already has __persistenceBackend, pass through
  if ("__persistenceBackend" in store && store.__persistenceBackend === true) {
    return store as PersistenceBackend;
  }
  // Otherwise, wrap it
  const s = store as SessionStore;
  return {
    __persistenceBackend: true as const,
    save: async (id, data) => {
      await s.save(id, data.messages);      // only saves messages, drops metadata
    },
    load: async (id) => {
      const messages = await s.load(id);
      if (!messages) return null;
      return { id, messages, createdAt: Date.now(), updatedAt: Date.now() };
    },
    delete: s.delete.bind(s),
    list: s.list.bind(s),
  };
}
```

Note the trade-off: legacy `SessionStore` loses `provider`, `model`, and `metadata` on load because it only stores messages. The adapter synthesizes `createdAt` and `updatedAt` from the current time.

---

## 3. SDK Adapter — Direct Backend Access

**File:** `src/adapters/sdk/agent.ts`

The SDK's `createAgent()` gives you a persistent agent with session memory. Here's how sessions are wired in:

### Backend Resolution — The `persist` Option

The `persist` option on `AgentCreateOptions` accepts three shapes:

```ts
// 1. String path → file backend at that path
const agent = await createAgent({ persist: "/tmp/my-sessions" });

// 2. PersistenceConfig → factory lookup
const agent = await createAgent({ persist: { type: "redis", url: "redis://..." } });

// 3. Raw backend (PersistenceBackend or legacy SessionStore)
const agent = await createAgent({ persist: myCustomBackend });
```

Resolution logic:

```ts
let backend: PersistenceBackend | null = null;
if (opts.persist) {
  if (typeof opts.persist === "string") {
    backend = createPersistenceBackend({ type: "file", path: opts.persist });
  } else if ("type" in opts.persist && typeof opts.persist.type === "string") {
    backend = createPersistenceBackend(opts.persist as PersistenceConfig);
  } else if ("save" in opts.persist && "load" in opts.persist) {
    backend = wrapAsPersistenceBackend(opts.persist as SessionStore | PersistenceBackend);
  }
}
```

### Session Loading — Restoring History

When the agent is created, it immediately tries to load an existing session:

```ts
if (backend) {
  const existing = await backend.load(sessionId);
  if (existing) {
    messages.push(...existing.messages);
  }
}
```

The `sessionId` is generated via `generateId()` (a UUID). On first creation, `existing` is `null` and messages starts empty. On subsequent calls with the same backend and session ID, the conversation history is restored.

### The `persistMessages()` Helper

```ts
async function persistMessages(): Promise<void> {
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

This is called **after every `chat()` and `chatStream()` call**. The flow:

```
chat("Hello!")
  → add user message to messages[]
  → runAgentLoop(...)
  → result received
  → persistMessages()  ← saves to backend
  → return AgentResponse
```

For `chatStream()`, persistence happens in the background after the stream completes:

```ts
// In chatStream(), the background async block:
try {
  const result = await runAgentLoop({...});
  // ...
} finally {
  stream.complete();
  await persistMessages();   // ← persists after streaming is done
  release();
}
```

### The Complete SDK Session Timeline

```
 USER CALL              SDK AGENT                     PERSISTENCE
 ───────────────────────────────────────────────────────────────────
 createAgent()     →   generate sessionId
                      backend.load(sessionId)
                      → null (new session)
                      messages = [system prompt]

 agent.chat("Hi")  →   messages.push(user msg)
                      runAgentLoop(messages, ...)
                      result = { text: "Hello!", ... }
                      persistMessages()
                      → backend.save(sessionId, messages)
                      → writes ~/.seepient/sessions/{id}.json

 agent.chat("Bye")  →   messages.push(user msg)
                      runAgentLoop(messages, ...)   ← includes prior history
                      result = { text: "Goodbye!", ... }
                      persistMessages()
                      → backend.save(sessionId, messages)
                      → overwrites {id}.json with full history
                      → createdAt PRESERVED from first write
```

---

## 4. CLI Adapter — No Persistence

**File:** `src/adapters/cli/repl.ts`

The CLI REPL does **not** use session persistence. Messages live only in the `Agent` class's `messages[]` array in memory. When the REPL exits, the conversation is gone.

There is no `persist` option. There is no `backend`. There is no session store call. The CLI is ephemeral by design.

If a user wants to persist a CLI conversation, they'd need to use the SDK or server instead.

---

## 5. Server Adapter — TTL, Limits, and Cleanup

**File:** `src/adapters/server/session-store.ts`

The server adds a **management layer** on top of a raw `PersistenceBackend`. It doesn't replace the backend — it wraps it with server-specific concerns.

### ServerSessionManager — The Wrapper

```ts
class ServerSessionManager {
  private sessions: Map<string, TrackedSession>;   // in-memory cache
  private backend: PersistenceBackend;              // disk/memory storage
  private sessionTTL: number;                       // absolute expiry (default: 24h)
  private inactivityTimeout: number;               // idle expiry (default: 30min)
  private maxSessionsPerKey: number;               // per-API-key limit (default: 5)
  private cleanupInterval: number;                  // how often to sweep (default: 5min)
}
```

### TrackedSession — Extended Metadata

```ts
interface TrackedSession extends SessionData {
  apiKeyHash: string;        // SHA-256 prefix — who owns this session
  lastActivityAt: number;    // epoch ms — for inactivity timeout
}
```

These two extra fields flow through `SessionData.metadata` when persisted:

```ts
metadata: {
  apiKeyHash: session.apiKeyHash,
  lastActivityAt: session.lastActivityAt,
}
```

### Session Creation — Enforcing Limits

```ts
async createSession(apiKey: string, provider?: ProviderType, model?: string): Promise<SessionData> {
  const keyHash = hashKey(apiKey);    // sha256 prefix

  // Check per-key limit
  const existing = this.getSessionsByKey(keyHash);
  if (existing.length >= this.maxSessionsPerKey) {
    throw new Error(
      `Maximum concurrent sessions (${this.maxSessionsPerKey}) reached for this API key.`
    );
  }

  const id = crypto.randomUUID();
  const now = Date.now();

  const session: TrackedSession = {
    id, messages: [],
    createdAt: now, updatedAt: now,
    lastActivityAt: now,
    apiKeyHash: keyHash,
    provider, model,
  };

  this.sessions.set(id, session);
  await this.persistSessionAsync(session);   // ← awaited — error propagates

  return { /* public SessionData fields */ };
}
```

The limit check counts only **non-expired** sessions belonging to that key. If you have 5 sessions but 2 are expired, you can create a new one.

### Session Retrieval — Ownership + Expiry Check

```ts
async getSession(id: string, apiKeyHash: string): Promise<SessionData | null> {
  let session = this.sessions.get(id);

  if (!session) {
    // Try loading from persistence backend (cold start recovery)
    session = await this.loadSessionFromBackend(id);
    if (!session) return null;
    this.sessions.set(id, session);
  }

  // Check expiration (absolute TTL + inactivity)
  if (this.isExpired(session)) {
    this.deleteSession(id);
    return null;
  }

  // Ownership verification — constant-time comparison
  if (!this.verifyOwnership(session, apiKeyHash)) {
    return null;    // not "unauthorized" — just "not found" (don't leak existence)
  }

  return { /* public SessionData fields */ };
}
```

Key behaviors:
- **Cold start recovery**: if the session isn't in memory (server restarted), it loads from the backend
- **Expiry check**: if expired, it's deleted immediately and returns `null`
- **Timing-safe ownership**: uses `crypto.timingSafeEqual` to prevent timing attacks

### Expiration Logic — Dual Timeout

```ts
private isExpired(session: TrackedSession): boolean {
  const now = Date.now();

  // Absolute TTL: 24 hours from creation
  if (now - session.createdAt > this.sessionTTL) {
    return true;
  }

  // Inactivity timeout: 30 minutes since last activity
  if (now - session.lastActivityAt > this.inactivityTimeout) {
    return true;
  }

  return false;
}
```

Two independent timers. A session expires if **either** is exceeded:
- **Absolute TTL** (24h): session can't live forever, even if active
- **Inactivity timeout** (30min): idle sessions get cleaned up

### Message Addition — Activity Tracking

```ts
addMessage(sessionId: string, message: Message): void {
  const session = this.sessions.get(sessionId);
  if (!session) return;

  session.messages.push(message);
  session.updatedAt = Date.now();
  session.lastActivityAt = Date.now();   // ← resets inactivity timer

  this.persistSession(session);          // fire-and-forget
}
```

Every message resets the inactivity clock. `persistSession()` is **not awaited** — best-effort persistence that never crashes the server.

### Periodic Cleanup

```ts
startCleanup(): void {
  if (this.cleanupTimer) return;
  this.cleanupTimer = setInterval(() => this.cleanup(), this.cleanupInterval);
  if (this.cleanupTimer.unref) {
    this.cleanupTimer.unref();    // don't keep process alive
  }
}

cleanup(): void {
  for (const [id, session] of this.sessions) {
    if (this.isExpired(session)) {
      this.deleteSession(id);
    }
  }
}
```

Runs every 5 minutes by default. Scans all in-memory sessions, deletes expired ones. The `unref()` call ensures the timer doesn't prevent Node.js from exiting.

### The Server Session Timeline

```
 CLIENT                         SERVER                         STORAGE
 ──────────────────────────────────────────────────────────────────────
 WebSocket connect          →   createSession(apiKey)
                               → createSession(apiKey)
                               → check per-key limit (5 max)
                               → generate UUID
                               → store in memory Map
                               → backend.save(session)     → {id}.json

 Send message               →   addMessage(sessionId, msg)
                               → push to session.messages
                               → update lastActivityAt
                               → backend.save(session)     → {id}.json

 Get session (REST)         →   getSession(sessionId, apiKeyHash)
                               → load from memory or backend
                               → check TTL + inactivity
                               → verify ownership (timing-safe)
                               → return SessionData

 5min cleanup timer fires   →   cleanup()
                               → scan all sessions
                               → delete expired ones
                               → backend.delete(id)        → unlink {id}.json
```

---

## 6. The Complete Picture — All Adapters Together

```
┌─────────────────────────────────────────────────────────────┐
│                     CORE TYPES                              │
│  SessionData, PersistenceBackend, PersistenceConfig         │
└──────────┬──────────────┬───────────────┬───────────────────┘
           │              │               │
    ┌──────▼──────┐ ┌─────▼─────┐ ┌──────▼───────────┐
    │  SDK Agent  │ │  CLI REPL │ │ Server Session   │
    │             │ │           │ │ Manager          │
    │ persist     │ │ (none)    │ │ wraps backend    │
    │ option →    │ │           │ │ with:            │
    │ backend     │ │ messages  │ │  - TTL (24h)     │
    │ resolves    │ │ in-memory │ │  - Inactivity    │
    │             │ │ only      │ │    (30min)       │
    │ save after  │ │           │ │  - Per-key       │
    │ every chat  │ │ exit =    │ │    limit (5)     │
    │             │ │ gone      │ │  - Cleanup       │
    │ load on     │ │           │ │    (5min)        │
    │ create      │ │           │ │                  │
    └──────┬──────┘ └───────────┘ └──────┬───────────┘
           │                             │
           │                             │
    ┌──────▼─────────────────────────────▼───────────┐
    │            PersistenceBackend                   │
    │  ┌──────────────┐  ┌────────────────────────┐  │
    │  │ FileBackend  │  │ MemoryBackend          │  │
    │  │ ~/.seepient/    │  │ Map<string, SessionData│  │
    │  │ sessions/    │  │ (testing only)         │  │
    │  │ {id}.json    │  │                        │  │
    │  │ atomic write │  │                        │  │
    │  └──────────────┘  └────────────────────────┘  │
    │                                                 │
    │  registerBackend("redis", factory)              │
    │  registerBackend("sqlite", factory)             │
    └─────────────────────────────────────────────────┘
```

---

## 7. Design Decisions and Trade-offs

| Decision | Rationale |
|----------|-----------|
| **Pluggable backends** | `PersistenceBackend` interface is 4 methods. Redis, SQLite, Postgres — anything that can save/load/delete/list works. |
| **Server separates concerns** | `ServerSessionManager` adds TTL/limits on top of raw persistence. The backend doesn't know about API keys or timeouts. |
| **Best-effort server writes** | `persistSession()` is fire-and-forget. A disk-full error logs a warning but never crashes the server. |
| **Legacy backward compat** | `wrapAsPersistenceBackend()` auto-adapts old `SessionStore` to `PersistenceBackend`. Trade-off: loses metadata on load. |
| **CLI is ephemeral** | No persistence in CLI by design. Keeps things simple. Users who want persistence use SDK or server. |
| **SDK `persist` is flexible** | String, config, or raw backend — three input shapes. Covers simple cases and advanced custom backends. |
| **Atomic file writes** | Write to `.tmp`, then rename. Prevents corruption on crash. |
| **Timing-safe ownership** | `crypto.timingSafeEqual` prevents timing attacks on API key verification. |
| **Dual timeout (TTL + inactivity)** | Absolute TTL prevents infinite session growth. Inactivity timeout cleans up abandoned sessions. |

---

## 8. Source Files Reference

| Component | File | Key exports |
|-----------|------|-------------|
| Core types | `src/core/types.ts` | `SessionData`, `PersistenceBackend`, `PersistenceConfig`, `SessionStore` |
| Persistence layer | `src/core/session-store.ts` | `FilePersistenceBackend`, `MemoryPersistenceBackend`, `createPersistenceBackend()`, `registerBackend()` |
| Core re-exports | `src/core/index.ts` | Re-exports all session store functions |
| SDK agent | `src/adapters/sdk/agent.ts` | `createAgent()` — wires `persist` option to backend |
| SDK re-exports | `src/adapters/sdk/index.ts` | Re-exports `registerBackend` for SDK consumers |
| Server manager | `src/adapters/server/session-store.ts` | `ServerSessionManager`, `hashKey()` |
| Server entry | `src/adapters/server/index.ts` | Creates `ServerSessionManager`, passes to REST + WebSocket |
| REST handler | `src/adapters/server/rest.ts` | `GET /v1/sessions/:id` — retrieves session via `ServerSessionManager` |
| WebSocket | `src/adapters/server/ws-handlers.ts` | Uses `sessionManager.getSession()` for message history |
| Tests | `src/core/__tests__/session-store.test.ts` | Round-trip, deletion, list, merge, ID validation, factory, custom backends |

---

## 9. Extending — Custom Backend Example

To add a Redis backend:

```ts
import { registerBackend } from "seepient";

class RedisPersistenceBackend implements PersistenceBackend {
  readonly __persistenceBackend = true as const;
  private client: Redis;

  constructor(config: PersistenceConfig) {
    this.client = new Redis(config.url as string);
  }

  async save(id: string, data: SessionData): Promise<void> {
    await this.client.set(`session:${id}`, JSON.stringify(data));
  }

  async load(id: string): Promise<SessionData | null> {
    const raw = await this.client.get(`session:${id}`);
    return raw ? JSON.parse(raw) : null;
  }

  async delete(id: string): Promise<void> {
    await this.client.del(`session:${id}`);
  }

  async list(): Promise<string[]> {
    const keys = await this.client.keys("session:*");
    return keys.map((k) => k.slice("session:".length));
  }
}

registerBackend("redis", (config) => new RedisPersistenceBackend(config));

// Now use it:
const agent = await createAgent({
  persist: { type: "redis", url: "redis://localhost:6379" },
});
```

---

## 10. Summary: What Each Adapter Does

| Adapter | Persistence? | Backend access | TTL | Limits | Cleanup |
|---------|-------------|----------------|-----|--------|---------|
| **SDK** | Optional (`persist` option) | Direct | None | None | None |
| **CLI** | None | None | N/A | None | N/A |
| **Server** | Always | Via `ServerSessionManager` wrapper | 24h absolute + 30min idle | 5 per API key | Every 5 min |

The power is in the layering: the **core persistence layer** handles storage mechanics, the **SDK** gives you direct access, and the **server** adds operational concerns on top — all sharing the same `PersistenceBackend` interface.
