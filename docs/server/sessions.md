---
title: Session Management
description: Seepient Agent Server session lifecycle, storage, TTL, concurrency limits, and reconnection protocol.
---

# Session Management

Sessions enable multi-turn conversations by persisting message history between requests. The server manages session creation, expiration, and cleanup automatically.

## Overview

```
┌─────────────────────────────────────────────┐
│            Session Lifecycle                 │
│                                              │
│  Create ──► Active ──► Inactive ──► Expired  │
│              │           │          │         │
│              │     30 min idle    24 hr TTL  │
│              │           │          │         │
│              └───────────┴──────────┘         │
│                     Cleanup (every 5 min)     │
└─────────────────────────────────────────────┘
```

## Storage

Sessions are stored as individual JSON files on disk:

```
./.seepient/sessions/
  ├── 550e8400-e29b-41d4-a716-446655440000.json
  ├── 660f9511-f3ac-52e5-b827-557766551111.json
  └── ...
```

The session directory defaults to `./.seepient/sessions/` relative to the working directory, and can be overridden with the `SEEPIENT_SESSION_DIR` environment variable.

### Session file format

Each file contains a single session as JSON:

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "messages": [
    {
      "id": "msg_001",
      "role": "user",
      "content": "What is closures in JavaScript?",
      "timestamp": 1712505600000
    },
    {
      "id": "msg_002",
      "role": "assistant",
      "content": "A closure is a function that has access to variables from its outer scope...",
      "timestamp": 1712505602000
    }
  ],
  "createdAt": 1712505600000,
  "updatedAt": 1712505602000,
  "provider": "anthropic",
  "model": "claude-sonnet-4-6-20260320"
}
```

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Session UUID (v4) |
| `messages` | `array` | Ordered list of messages |
| `messages[].id` | `string` | Message UUID |
| `messages[].role` | `string` | `"user"` or `"assistant"` |
| `messages[].content` | `string` | Message text |
| `messages[].timestamp` | `number` | Unix timestamp in milliseconds |
| `createdAt` | `number` | Session creation timestamp (ms) |
| `updatedAt` | `number` | Last update timestamp (ms) |
| `provider` | `string` | LLM provider (optional) |
| `model` | `string` | Model ID (optional) |

## TTL and expiration

Sessions expire based on two independent conditions:

| Condition | Default | Configurable |
|---|---|---|
| **Absolute TTL** | 24 hours from creation | `SEEPIENT_SESSION_TTL` env (seconds) or `sessionTTL` server option |
| **Inactivity timeout** | 30 minutes since last activity | `inactivityTimeout` server option (milliseconds) |

A session is considered expired when **either** condition is met. Expired sessions are automatically deleted from memory and disk.

### Configuring TTL

```typescript
import { createServer } from "seepient/server";

await createServer({
  sessionTTL: 7200, // 2 hours in seconds
});
```

Or via environment variable:

```bash
SEEPIENT_SESSION_TTL=7200 seepient server
```

## Concurrency limits

Each API key is limited to **5 concurrent active sessions** by default. When the limit is reached, creating a new session returns an error.

```
Maximum concurrent sessions (5) reached for this API key.
```

To free up a slot, either wait for sessions to expire or delete them explicitly.

## Auto-cleanup

The server runs a cleanup sweep every **5 minutes** that:

1. Iterates all in-memory sessions
2. Checks TTL and inactivity conditions
3. Deletes expired sessions from memory and disk

The cleanup timer uses `.unref()` so it does not prevent graceful process shutdown.

## Session creation

Sessions are created implicitly when a WebSocket `chat` message includes a `sessionId`, or explicitly by the server when no session ID is provided.

### Via WebSocket

```json
{
  "type": "chat",
  "id": "msg-001",
  "message": "Hello!",
  "sessionId": null
}
```

The server creates a new session and subsequent messages with the same `sessionId` will append to it.

### Via REST

The REST `/v1/chat` endpoint is stateless and does not create sessions. Use the WebSocket API for session-based conversations.

## Reconnection protocol

When a WebSocket connection drops, clients can recover their session state:

### 1. Reconnect with `reconnect`

```json
{
  "type": "reconnect",
  "sessionId": "550e8400-...",
  "lastSeenId": "msg_005"
}
```

The server responds with a `replay` message containing any messages after `lastSeenId`:

```json
{
  "type": "replay",
  "messages": [
    { "id": "msg_006", "role": "assistant", "content": "...", "timestamp": 1712505610000 }
  ],
  "currentStatus": "ready"
}
```

### 2. Resume with `resume`

```json
{
  "type": "resume",
  "sessionId": "550e8400-..."
}
```

The server responds with the full session history:

```json
{
  "type": "session_resumed",
  "sessionId": "550e8400-...",
  "messages": [/* all messages */]
}
```

### 3. Session not found

If the session has expired or does not exist:

```json
{
  "type": "error",
  "code": "SESSION_NOT_FOUND",
  "retryable": false,
  "message": "Session 550e8400-... not found or expired"
}
```

::: tip Reconnect vs Resume
Use `reconnect` when you know the last message you received and only need the delta. Use `resume` when you need the full conversation history (e.g., page refresh).
:::

## Persistence behavior

- Sessions are persisted to disk after every message
- The server loads sessions from disk on demand (lazy loading)
- **Writes are atomic** (v0.2.2+): data is written to a temporary file first, then renamed into place. A crash mid-write never leaves a corrupt session file.
- Persistence is best-effort -- write failures do not crash the server
- In-memory sessions are rebuilt from disk on server restart
