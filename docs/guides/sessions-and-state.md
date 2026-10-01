---
title: Sessions and state
description: Session persistence, conversation resumption, and embedder-owned storage in Seepient.
---

# Sessions and state

Seepient preserves conversation history across runs. A session records every user prompt, model thinking step, tool invocation, prepared action, and approval decision.

## Session storage

By default, Seepient writes session records to `~/.seepient/sessions/` using atomic JSON files. Each session receives a unique identifier based on timestamp and hash.

### Resuming sessions from the CLI

Resume a previous conversation by session ID:

```bash
seepient --resume sess_20260905_a1b2c3
# Or using the shorthand flag:
seepient -r sess_20260905_a1b2c3
```

To resume your most recent conversation, pass `last`:

```bash
seepient -r last
```

### Managing sessions in the TUI

Inside the interactive terminal interface:

- `/sessions`: Opens an interactive session selector overlay with fuzzy search to browse, inspect, and resume previous sessions.
- `/clear`: Clears the current conversation view.

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
