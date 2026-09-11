---
title: Sessions and state
description: Session persistence, conversation resumption, and embedder-owned storage in Seepient.
---

# Sessions and state

Seepient preserves conversation history across runs. A session records every user prompt, model thinking step, tool invocation, prepared action, and approval decision.

## Session storage

By default, Seepient writes session records to `~/.seepient/sessions/` using atomic JSON files. Each session receives a unique identifier based on timestamp and hash.

### Managing sessions from the CLI

List previous sessions:

```bash
seepient sessions list
```

Resume a previous conversation:

```bash
seepient --session sess_20260905_a1b2c3
```

Export a session to a markdown transcript:

```bash
seepient sessions export sess_20260905_a1b2c3 --output ./transcript.md
```

### Managing sessions in the TUI

Inside the interactive terminal interface:

- `/session list`: Shows recent sessions in an interactive list selector.
- `/session resume <id>`: Swaps context to the selected session.
- `/session new`: Starts a fresh session while leaving the current one saved on disk.

## Session forking

When experimenting with alternate prompts or refactoring paths, you can fork an existing session from a specific turn:

```bash
seepient sessions fork sess_20260905_a1b2c3 --turn 4
```

The new session inherits the conversation history up to turn 4, creating an independent branch that does not overwrite the parent session.

## Embedder-owned storage (SDK)

In serverless environments or multi-tenant web applications, writing to a local home directory is not always possible. The TypeScript SDK supports **embedder-owned storage**.

You can inject custom storage adapters directly into `createSeepient`:

```typescript
import { createSeepient, type PersistenceBackend, type SessionData } from 'seepient'

class RedisPersistenceBackend implements PersistenceBackend {
  readonly __persistenceBackend = true as const

  async save(sessionId: string, data: SessionData): Promise<void> { /* ... write to redis ... */ }
  async load(sessionId: string): Promise<SessionData | null> { /* ... fetch from redis ... */ }
  async delete(sessionId: string): Promise<void> { /* ... */ }
  async list(): Promise<string[]> { /* ... */ }
}

const agent = await createSeepient({
  persist: new RedisPersistenceBackend(),
  sessionId: 'user_42_workspace_99'
})
```

This architecture allows Seepient to run in zero-disk containers, Lambda functions, or Cloudflare Workers while delegating session persistence to your database of choice.
