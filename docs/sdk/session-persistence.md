---
title: Session Persistence
description: Persist and restore agent conversation history with built-in and custom session stores.
---

# Session Persistence

Seepient Agent agents can persist conversation history across process restarts using session stores. Pass a `persist` option to `createAgent()` and the agent automatically saves and loads messages.

## Quick example

```typescript
import { createAgent } from "seepient";

// File-based persistence -- sessions stored as JSON files
const agent = await createAgent({
  persist: "./sessions/my-agent",
});

await agent.chat("My name is Alice");
await agent.chat("I am working on a React project");

// In a new process, recreate with the same path:
// const agent2 = await createAgent({ persist: "./sessions/my-agent" });
// History is loaded automatically.
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
Session IDs must contain only alphanumeric characters and dashes (`[a-zA-Z0-9-]+`). Invalid IDs throw an error on save.
:::

### MemoryPersistenceBackend

In-memory storage backed by a `Map`. Sessions are lost when the process exits.

```typescript
import { createPersistenceBackend } from "seepient";

const store = createPersistenceBackend({ type: "memory" });

// Useful for testing
const agent = await createAgent({
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

## Usage with createAgent

### File path (string)

Pass a directory path as a string. Seepient Agent creates a `FilePersistenceBackend` automatically:

```typescript
const agent = await createAgent({
  persist: "./data/sessions",
});
```

### PersistenceBackend instance

Pass any `PersistenceBackend` implementation:

```typescript
import { createPersistenceBackend } from "seepient";

const store = createPersistenceBackend({ type: "file", path: "./data/sessions" });

const agent = await createAgent({
  persist: store,
});
```

### Auto-generated session IDs

When you use `createAgent()` with a `persist` option, Seepient Agent auto-generates a session ID. Each agent instance gets its own session file:

```typescript
// Each creates a separate session file
const agent1 = await createAgent({ persist: "./sessions" });
const agent2 = await createAgent({ persist: "./sessions" });

await agent1.chat("Hello from agent 1");
await agent2.chat("Hello from agent 2");

// Both histories are persisted independently
```

## Session lifecycle

### Save behavior

The session is automatically saved after each `chat()` and `chatStream()` call:

```typescript
const agent = await createAgent({ persist: "./sessions" });

// Saves to disk after each call
await agent.chat("First message");    // Session saved
await agent.chat("Second message");   // Session updated
```

### Load behavior

When an agent is created with a persist path that contains existing session data, the history is loaded automatically:

```typescript
// Process 1: create and chat
const agent = await createAgent({ persist: "./sessions/app" });
await agent.chat("Remember: project uses TypeScript");

// Process 2: resume (same path)
const resumedAgent = await createAgent({ persist: "./sessions/app" });
const reply = await resumedAgent.chat("What language does the project use?");
// The agent remembers the TypeScript context
```

### Clearing sessions

Use `agent.clear()` to reset conversation history. The session file is updated:

```typescript
const agent = await createAgent({ persist: "./sessions" });

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
import { createAgent, type PersistenceBackend, type SessionData } from "seepient";
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

const agent = await createAgent({ persist: redisStore });
```

### Database session store

```typescript
import { createAgent, type PersistenceBackend, type SessionData } from "seepient";

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

const agent = await createAgent({ persist: dbStore });
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

- [createAgent()](/sdk/create-agent) -- Stateful agent with `persist` option
- [Types](/sdk/types) -- Full TypeScript type reference including `PersistenceBackend` and `SessionData`
