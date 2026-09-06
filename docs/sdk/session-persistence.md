---
title: Session Persistence
description: Persist and restore agent conversation history with built-in and custom session stores.
---

# Session Persistence

Seepient Agent agents can persist conversation history across process restarts using session stores. Pass a `persist` option to `createSeepient()` and the agent automatically saves and loads messages.

## Quick example

```typescript
import { createSeepient } from "seepient";

// File-based persistence -- sessions stored as JSON files
const agent = await createSeepient({
  persist: "./sessions/my-agent",
});

await agent.chat("My name is Alice");
await agent.chat("I am working on a React project");

// Explicit Session ID & Multi-Turn Resumption (Spec 021)
const agent1 = await createSeepient({
  sessionId: "user-alice-session",
  providerAccount: "team-anthropic", // Persisted and restored with session
  persist: myCustomBackend,
});
await agent1.chat("Remember my project context");

// In a subsequent worker/request:
const agent2 = await createSeepient({
  sessionId: "user-alice-session",
  principalId: "user-alice", // Must match the principal that created the session
  persist: myCustomBackend,
});
// Full conversation history and providerAccount are loaded automatically from myCustomBackend
console.log(agent2.sessionId); // "user-alice-session"
```

## PersistenceBackend interface

All persistence backends implement the same interface:

```typescript
interface PersistenceBackend {
  /** Brand discriminator — distinguishes from SessionStore. */
  readonly __persistenceBackend: true;

  /** Save session data (messages, metadata, timestamps). Creates or updates. */
  save(sessionId: string, data: SessionData): Promise<void>;

  /** Load full session data. Returns null if not found. */
  load(sessionId: string): Promise<SessionData | null>;

  /** Delete a session. */
  delete(sessionId: string): Promise<void>;

  /** List all session IDs. */
  list(): Promise<string[]>;
}
```

::: warning Breaking change in v0.2.2
Third-party `PersistenceBackend` implementations must now include `readonly __persistenceBackend = true as const`. This brand field prevents the SDK from accidentally wrapping a `PersistenceBackend` and stripping metadata (`createdAt`, `provider`, `model`, custom `metadata`).
:::

## Persistence Fidelity Tiers

Seepient supports two tiers of session persistence contracts with distinct fidelity guarantees:

| Contract | Structure | Metadata Support | Tradeoff |
|---|---|---|---|
| `PersistenceBackend` | Full `SessionData` object (`messages`, `createdAt`, `updatedAt`, `provider`, `model`, `providerAccount`, `metadata`) | Full fidelity. Preserves exact creation times, model configurations, and custom application metadata across process restarts. | **Recommended for production.** Requires implementing `save`, `load`, `delete`, and `list` with the brand discriminator `readonly __persistenceBackend = true as const`. |
| `SessionStore` (Adapter) | Array of `Message[]` (`get`, `set`) | Messages only. Automatically wrapped via `wrapAsPersistenceBackend`. | Discards provider, model, and custom metadata. Generates synthetic timestamps (`createdAt`/`updatedAt` set to load time). Best for simple or legacy backends. |

### When to choose which contract

- **Choose `PersistenceBackend`** when building production multi-tenant backends, worker fleets, or when you need audit logs and conversation resumption to accurately reflect the originating provider and model parameters.
- **Choose `SessionStore`** only when adapting legacy key-value stores that store exclusively raw message arrays and do not need session-level metadata.

## Asymmetric Storage Keying

When injecting storage contracts into `createSeepient` or `runSeepientServer` in distributed or multi-tenant architectures, understand that Seepient partitions state across different scoping keys along distinct fault and security boundaries:

| Store Contract | Scoping Key | Scope Boundary | Purpose |
|---|---|---|---|
| `AuditStore` | `principalId` | Actor / Identity | Durably attributes every tool execution and security decision to the authenticated user, API key, or system principal. |
| `CapabilityLedger` | `principalId` | Actor / Identity | Tracks granted capabilities, active approvals, and one-shot authorizations per actor. |
| `PersistenceBackend` | `sessionId` | Conversation | Isolates chat turns, message histories, and session resumes to a single conversational thread. |
| `PolicyStore` | `workspace` | Directory / Filesystem | Governs filesystem paths, tool consent modes, and sandbox boundaries for the specific project workspace. |

This asymmetric design guarantees that actor accountability (`principalId`) is never conflated with workspace filesystem policies or conversation threads (`sessionId`).

::: warning Session ownership — resume is principal-bound
Persisted sessions carry the `principalId` that created them (default `"sdk-user"`). Resuming a session under a different `principalId` fails closed with a `SESSION_OWNERSHIP_MISMATCH` error — the conversation history is never restored or continued across principals, even when tenants share one `PersistenceBackend`. Sessions persisted before ownership tracking (and sessions stored through the metadata-less `SessionStore` adapter) carry no owner stamp and are likewise not resumable. Custom `PersistenceBackend` implementations must round-trip the `principalId` field of `SessionData` to preserve this guarantee.
:::

## Built-in stores

Seepient Agent ships with two session store implementations.

### FilePersistenceBackend

File-backed storage. Each session is a JSON file in a directory. Writes are **atomic** — data is written to a temporary file first, then renamed into place, so a crash mid-write never leaves a corrupt session file.

```typescript
import { createPersistenceBackend } from "seepient";

// Default: stores in ~/.seepient/sessions/
const store = createPersistenceBackend({ type: "file" });

// Custom directory
const customStore = createPersistenceBackend({ type: "file", path: "./data/my-sessions" });
```

| Property         | Value                                      |
|------------------|--------------------------------------------|
| Storage          | JSON files, one per session                |
| Default path     | `~/.seepient/sessions/`                       |
| File naming      | `{sessionId}.json`                         |
| Auto-creates dir | Yes                                        |
| Write safety     | Atomic (tmp + rename)                      |

Each session file contains a `SessionData` object:

```typescript
interface SessionData {
  id: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
  provider?: ProviderType;
  model?: string;
  metadata?: Record<string, unknown>;
}
```

::: info
Session IDs must contain only alphanumeric characters, dashes, and underscores (`^[a-zA-Z0-9_-]+$`). Invalid IDs throw an error on save.
:::

### MemoryPersistenceBackend

In-memory storage backed by a `Map`. Sessions are lost when the process exits.

```typescript
import { createPersistenceBackend } from "seepient";

const store = createPersistenceBackend({ type: "memory" });

// Useful for testing
const agent = await createSeepient({
  persist: store,
});
```

| Property         | Value                          |
|------------------|--------------------------------|
| Storage          | In-memory `Map<string, SessionData>` |
| Persistence      | Process lifetime only          |
| Best for         | Testing, ephemeral sessions   |

### Choosing a store

| Use case                      | Recommended store    |
|-------------------------------|----------------------|
| Production, long-lived agents | `FilePersistenceBackend`   |
| Testing                       | `MemoryPersistenceBackend` |
| Distributed deployment        | Custom Redis store   |
| Serverless functions          | Custom database store|

## Usage with createSeepient

### File path (string)

Pass a directory path as a string. Seepient Agent creates a `FilePersistenceBackend` automatically:

```typescript
const agent = await createSeepient({
  persist: "./data/sessions",
});
```

### PersistenceBackend instance

Pass any `PersistenceBackend` implementation:

```typescript
import { createPersistenceBackend } from "seepient";

const store = createPersistenceBackend({ type: "file", path: "./data/sessions" });

const agent = await createSeepient({
  persist: store,
});
```

### Auto-generated session IDs

When you use `createSeepient()` with a `persist` option, Seepient Agent auto-generates a session ID. Each agent instance gets its own session file:

```typescript
// Each creates a separate session file
const agent1 = await createSeepient({ persist: "./sessions" });
const agent2 = await createSeepient({ persist: "./sessions" });

await agent1.chat("Hello from agent 1");
await agent2.chat("Hello from agent 2");

// Both histories are persisted independently
```

## Session lifecycle

### Save behavior

The session is automatically saved after each `chat()` and `chatStream()` call:

```typescript
const agent = await createSeepient({ persist: "./sessions" });

// Saves to disk after each call
await agent.chat("First message");    // Session saved
await agent.chat("Second message");   // Session updated
```

### Load behavior

When an agent is created with a persist path that contains existing session data, the history is loaded automatically:

```typescript
// Process 1: create and chat
const agent = await createSeepient({ persist: "./sessions/app" });
await agent.chat("Remember: project uses TypeScript");

// Process 2: resume (same path)
const resumedAgent = await createSeepient({ persist: "./sessions/app" });
const reply = await resumedAgent.chat("What language does the project use?");
// The agent remembers the TypeScript context
```

### Clearing sessions

Use `agent.clear()` to reset conversation history. The session file is updated:

```typescript
const agent = await createSeepient({ persist: "./sessions" });

await agent.chat("Some context");
agent.clear();
// Session file updated with just the system prompt
```

## Session limits and cleanup

Seepient Agent enforces the following session limits to prevent resource exhaustion:

| Limit                  | Value      | Description                                        |
|------------------------|------------|----------------------------------------------------|
| Session TTL            | 24 hours   | Sessions older than 24 hours are eligible for cleanup |
| Inactivity timeout     | 30 minutes | Sessions with no activity for 30 minutes may be cleaned up |
| Max concurrent sessions| 5 per key  | Maximum 5 active sessions per API key              |
| Auto-cleanup interval  | 5 minutes  | Background cleanup runs every 5 minutes            |

::: warning
These limits apply to the Server adapter's `ServerSessionManager`, which manages sessions for API consumers. The core SDK's `FilePersistenceBackend` and `MemoryPersistenceBackend` have NO built-in TTL, inactivity timeout, or automatic cleanup. For direct SDK usage, implement your own cleanup logic for production deployments.
:::

### Manual cleanup

```typescript
import { createPersistenceBackend } from "seepient";

const store = createPersistenceBackend({ type: "file", path: "./sessions" });

// List all sessions
const sessions = await store.list();

// Delete expired sessions manually
const ONE_DAY = 24 * 60 * 60 * 1000;
for (const id of sessions) {
  const data = await store.load(id);
  if (!data) continue;

  if (Date.now() - data.updatedAt > ONE_DAY) {
    await store.delete(id);
    console.log(`Cleaned up session: ${id}`);
  }
}
```

## Custom session store

Implement the `PersistenceBackend` interface to use any backend.

### Redis session store

```typescript
import { createSeepient, type PersistenceBackend, type SessionData } from "seepient";
import { createClient } from "redis";

const redis = createClient({ url: "redis://localhost:6379" });
await redis.connect();

const redisStore: PersistenceBackend = {
  readonly __persistenceBackend: true as const,

  async save(sessionId: string, data: SessionData): Promise<void> {
    const key = `seepient:session:${sessionId}`;
    await redis.set(key, JSON.stringify(data), {
      EX: 86400, // 24-hour TTL
    });
  },

  async load(sessionId: string): Promise<SessionData | null> {
    const raw = await redis.get(`seepient:session:${sessionId}`);
    if (!raw) return null;
    return JSON.parse(raw);
  },

  async delete(sessionId: string): Promise<void> {
    await redis.del(`seepient:session:${sessionId}`);
  },

  async list(): Promise<string[]> {
    const keys = await redis.keys("seepient:session:*");
    return keys.map((k) => k.replace("seepient:session:", ""));
  },
};

const agent = await createSeepient({ persist: redisStore });
```

### Database session store

```typescript
import { createSeepient, type PersistenceBackend, type SessionData } from "seepient";

// Example with a generic database client
const dbStore: PersistenceBackend = {
  readonly __persistenceBackend: true as const,

  async save(sessionId: string, data: SessionData): Promise<void> {
    await db.query(
      `INSERT INTO sessions (id, messages, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (id) DO UPDATE
       SET messages = $2, updated_at = NOW()`,
      [sessionId, JSON.stringify(data.messages)],
    );
  },

  async load(sessionId: string): Promise<SessionData | null> {
    const row = await db.query(
      "SELECT messages FROM sessions WHERE id = $1",
      [sessionId],
    );
    if (!row) return null;
    return JSON.parse(row.messages);
  },

  async delete(sessionId: string): Promise<void> {
    await db.query("DELETE FROM sessions WHERE id = $1", [sessionId]);
  },

  async list(): Promise<string[]> {
    const rows = await db.query("SELECT id FROM sessions ORDER BY updated_at DESC");
    return rows.map((r: { id: string }) => r.id);
  },
};

const agent = await createSeepient({ persist: dbStore });
```

::: tip
For custom stores, implement TTL cleanup in your backend (Redis EX, database cron job, etc.) to prevent unbounded storage growth.
:::

## PersistenceBackend factories

| Function                       | Signature                                        | Returns                     |
|--------------------------------|--------------------------------------------------|-----------------------------|
| `createPersistenceBackend()`   | `(config: PersistenceConfig) => PersistenceBackend` | `FilePersistenceBackend` or `MemoryPersistenceBackend` |
| `createSessionStore()`         | `(path?: string) => PersistenceBackend`          | `FilePersistenceBackend` (legacy, deprecated) |
| `createMemoryStore()`          | `() => PersistenceBackend`                       | `MemoryPersistenceBackend` (legacy, deprecated) |

```typescript
import { createPersistenceBackend } from "seepient";

// Production: file-based
const fileStore = createPersistenceBackend({ type: "file", path: "./data/sessions" });

// Testing: in-memory
const testStore = createPersistenceBackend({ type: "memory" });
```

::: tip
`createSessionStore()` and `createMemoryStore()` are **deprecated** aliases. Use `createPersistenceBackend()` for new code.
:::

## Related APIs

- [createSeepient()](/sdk/create-seepient) -- Stateful agent with `persist` option
- [Types](/sdk/types) -- Full TypeScript type reference including `PersistenceBackend` and `SessionData`
