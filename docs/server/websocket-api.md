---
title: WebSocket API Reference
description: Full Seepient Agent WebSocket protocol reference for real-time streaming conversations.
---

# WebSocket API Reference

The WebSocket endpoint enables real-time, bidirectional communication for streaming text, tool execution, session management, and provider switching -- all over a single persistent connection.

## Connection

### Endpoint

```
ws://localhost:7337/ws?token=sk_seepient_...
```

Authentication is performed via the `token` query parameter. The server validates the API key during the HTTP upgrade. If the key is invalid, the upgrade is rejected with `401 Unauthorized`.

### Upgrade lifecycle

1. Client initiates a WebSocket upgrade to `/ws?token=sk_seepient_...`
2. Server validates the API key
3. On success, the connection is established and ready for messages
4. On failure, the socket is destroyed with a `401` response

::: warning Connection close on auth failure
If authentication fails after upgrade (should not happen in normal flow), the server sends an `error` message with code `UNAUTHORIZED` and closes the connection with code `4001`.
:::

---

## Client-to-Server messages

All client messages are JSON. Every message must include a `type` field.

### `chat`

Send a user message and receive a streaming response.

```json
{
  "type": "chat",
  "id": "client-msg-001",
  "message": "Explain closures in JavaScript",
  "options": {
    "model": "claude-sonnet-4-6-20260320",
    "provider": "anthropic",
    "tools": ["execute_shell_command"],
    "maxSteps": 10,
    "skills": ["code-review"]
  },
  "sessionId": "550e8400-e29b-41d4-a716-446655440000"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | `string` | Yes | Client-generated message ID for correlation |
| `message` | `string` | Yes | The user prompt |
| `options.model` | `string` | No | Model ID (overrides connection default) |
| `options.provider` | `string` | No | Provider name (overrides connection default) |
| `options.tools` | `string[]` | No | Tool names or group names to enable |
| `options.maxSteps` | `number` | No | Max agent loop iterations (default: `10`) |
| `options.skills` | `string[]` | No | Skill names to activate |
| `sessionId` | `string` | No | Resume an existing session |

### `abort`

Cancel the current in-flight chat request. The AbortSignal is passed through to the provider SDK, so the underlying HTTP request to the LLM is cancelled at the network level.

```json
{
  "type": "abort",
  "reason": "User cancelled"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `reason` | `string` | No | Optional reason for abort |

### `resume`

Resume an existing session by ID. The server replies with `session_resumed` containing the message history.

```json
{
  "type": "resume",
  "sessionId": "550e8400-e29b-41d4-a716-446655440000",
  "lastMessageId": "msg_005"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `sessionId` | `string` | Yes | Session to resume |
| `lastMessageId` | `string` | No | Last message the client has seen |

### `reconnect`

Reconnect after a dropped connection. The server replies with `replay` containing messages after `lastSeenId`.

```json
{
  "type": "reconnect",
  "sessionId": "550e8400-e29b-41d4-a716-446655440000",
  "lastSeenId": "msg_005"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `sessionId` | `string` | Yes | Session to reconnect to |
| `lastSeenId` | `string` | No | Last message ID the client processed |

### `switch_provider`

Change the active provider and/or model for subsequent messages on this connection.

```json
{
  "type": "switch_provider",
  "provider": "openai",
  "model": "gpt-5.4"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `provider` | `string` | Yes | New provider name |
| `model` | `string` | No | New default model |

### `list_models`

Request the list of models available from your configured inference providers. Seepient Agent does not host models — it forwards requests to your provider APIs. The server replies with `models_list`.

```json
{
  "type": "list_models"
}
```

### `list_skills`

Request the list of available skills. The server replies with `skills_list`.

```json
{
  "type": "list_skills"
}
```

### `ping`

Heartbeat / latency measurement. The server replies with `pong`.

```json
{
  "type": "ping",
  "clientTime": "2026-04-08T12:00:00.000Z"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `clientTime` | `string` | Yes | ISO 8601 client timestamp |

---

## Server-to-Client messages

### `ack`

Confirms receipt of a client message. Sent immediately after a `chat` message is received.

```json
{
  "type": "ack",
  "clientMsgId": "client-msg-001",
  "serverMsgId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "timestamp": "2026-04-08T12:00:01.000Z"
}
```

| Field | Type | Description |
|---|---|---|
| `clientMsgId` | `string` | Matches the `id` from the client's `chat` message |
| `serverMsgId` | `string` | Server-generated ID for this generation |
| `timestamp` | `string` | ISO 8601 timestamp |

### `text`

Streaming text delta. Multiple `text` messages are sent as the model generates tokens.

```json
{
  "type": "text",
  "delta": "A closure is ",
  "serverMsgId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
}
```

| Field | Type | Description |
|---|---|---|
| `delta` | `string` | Incremental text chunk |
| `serverMsgId` | `string` | Correlates with the `ack` |

### `tool_call`

Indicates the agent is invoking a tool.

```json
{
  "type": "tool_call",
  "callId": "call_abc123",
  "name": "execute_shell_command",
  "args": { "command": "ls -la" }
}
```

| Field | Type | Description |
|---|---|---|
| `callId` | `string` | Unique tool call identifier |
| `name` | `string` | Tool name |
| `args` | `object` | Arguments passed to the tool |

### `tool_progress`

Progress update during a long-running tool execution.

```json
{
  "type": "tool_progress",
  "callId": "call_abc123",
  "percentage": 50,
  "output": "Processing file 5 of 10..."
}
```

| Field | Type | Description |
|---|---|---|
| `callId` | `string` | Matches the `tool_call` |
| `percentage` | `number` | Progress percentage (0-100) |
| `output` | `string` | Optional partial output |

### `tool_result`

Final result of a tool invocation.

```json
{
  "type": "tool_result",
  "callId": "call_abc123",
  "output": "README.md\npackage.json\nsrc/",
  "success": true
}
```

| Field | Type | Description |
|---|---|---|
| `callId` | `string` | Matches the `tool_call` |
| `output` | `string` | Tool execution result |
| `success` | `boolean` | Whether the tool succeeded |

### `progress`

Agent loop progress update.

```json
{
  "type": "progress",
  "step": 2,
  "totalSteps": 5,
  "percentage": 40,
  "activity": "Executing tool: execute_shell_command"
}
```

| Field | Type | Description |
|---|---|---|
| `step` | `number` | Current step number |
| `totalSteps` | `number` | Estimated total steps (may be 0 if unknown) |
| `percentage` | `number` | Progress percentage |
| `activity` | `string` | Description of current activity |

### `done`

Signals the end of a generation. Always sent as the final message in a chat flow.

```json
{
  "type": "done",
  "serverMsgId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "usage": {
    "promptTokens": 245,
    "completionTokens": 187,
    "totalTokens": 432,
    "cost": 0.0041
  },
  "finishReason": "stop"
}
```

| Field | Type | Description |
|---|---|---|
| `serverMsgId` | `string` | Correlates with the `ack` |
| `usage` | `object` | Token usage and cost |
| `usage.promptTokens` | `number` | Tokens in the prompt |
| `usage.completionTokens` | `number` | Tokens in the completion |
| `usage.totalTokens` | `number` | Total tokens consumed |
| `usage.cost` | `number` | Estimated cost in USD |
| `finishReason` | `string` | `"stop"`, `"tool_calls"`, `"length"`, or `"error"` |

### `error`

An error occurred. May be sent at any time during a chat flow or connection lifecycle.

```json
{
  "type": "error",
  "code": "PROVIDER_ERROR",
  "retryable": true,
  "message": "OpenAI API returned 429: rate limit exceeded",
  "provider": "openai"
}
```

| Field | Type | Description |
|---|---|---|
| `code` | `string` | Error code (see table below) |
| `retryable` | `boolean` | Whether the client should retry |
| `message` | `string` | Human-readable error description |
| `provider` | `string` | Provider that caused the error (optional) |
| `tool` | `string` | Tool that caused the error (optional) |

### `pong`

Response to a client `ping`.

```json
{
  "type": "pong",
  "serverTime": "2026-04-08T12:00:01.500Z"
}
```

| Field | Type | Description |
|---|---|---|
| `serverTime` | `string` | ISO 8601 server timestamp |

### `models_list`

Response to `list_models`.

```json
{
  "type": "models_list",
  "models": {
    "openai": ["gpt-5.4", "gpt-5.4-pro", "gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.3-instant", "gpt-5.3-codex", "o3", "o3-mini"],
    "anthropic": ["claude-sonnet-4-6-20260320", "claude-opus-4-6-20260320", "claude-haiku-4-5-20251001"],
    "glm": ["opus", "sonnet", "haiku"],
    "openai-compatible": ["(user-configured)"]
  }
}
```

### `skills_list`

Response to `list_skills`.

```json
{
  "type": "skills_list",
  "skills": [
    { "name": "code-review", "description": "...", "tags": ["code"] }
  ]
}
```

### `session_resumed`

Response to `resume`. Contains the session's message history.

```json
{
  "type": "session_resumed",
  "sessionId": "550e8400-e29b-41d4-a716-446655440000",
  "messages": [
    { "id": "msg_001", "role": "user", "content": "Hello", "timestamp": 1712505600000 },
    { "id": "msg_002", "role": "assistant", "content": "Hi there!", "timestamp": 1712505601000 }
  ]
}
```

### `replay`

Response to `reconnect`. Contains messages the client may have missed.

```json
{
  "type": "replay",
  "messages": [
    { "id": "msg_006", "role": "assistant", "content": "...", "timestamp": 1712505610000 }
  ],
  "currentStatus": "ready"
}
```

---

## Error codes

| Code | Retryable | Description |
|---|---|---|
| `UNAUTHORIZED` | No | Invalid or missing API key |
| `INVALID_MESSAGE` | No | Malformed JSON in client message |
| `UNKNOWN_MESSAGE_TYPE` | No | Unrecognized `type` field |
| `PROVIDER_ERROR` | Yes | LLM provider returned an error |
| `STREAM_ERROR` | No | Internal streaming failure |
| `SESSION_NOT_FOUND` | No | Session expired or does not exist |
| `ABORTED` | No | Request aborted by client |

---

## Client examples

### JavaScript / TypeScript (browser)

```typescript
const ws = new WebSocket("ws://localhost:7337/ws?token=sk_seepient_...");

ws.onopen = () => {
  // Start a chat
  ws.send(JSON.stringify({
    type: "chat",
    id: crypto.randomUUID(),
    message: "Explain closures in JavaScript",
    options: {
      provider: "anthropic",
      tools: [],
      maxSteps: 5
    }
  }));
};

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);

  switch (msg.type) {
    case "ack":
      console.log("Server acknowledged:", msg.serverMsgId);
      break;
    case "text":
      process.stdout.write(msg.delta);
      break;
    case "tool_call":
      console.log(`Tool call: ${msg.name}`, msg.args);
      break;
    case "tool_result":
      console.log(`Tool result (${msg.success}):`, msg.output);
      break;
    case "done":
      console.log("\nDone. Tokens:", msg.usage.totalTokens);
      break;
    case "error":
      console.error("Error:", msg.code, msg.message);
      break;
  }
};

// Heartbeat every 30 seconds
setInterval(() => {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "ping", clientTime: new Date().toISOString() }));
  }
}, 30000);
```

### Python (websockets)

```python
import asyncio
import json
import uuid
from websockets import connect

async def chat():
    uri = "ws://localhost:7337/ws?token=sk_seepient_..."

    async with connect(uri) as ws:
        # Send a chat message
        await ws.send(json.dumps({
            "type": "chat",
            "id": str(uuid.uuid4()),
            "message": "Write a Python hello world",
            "options": {
                "provider": "openai",
                "model": "gpt-5.4",
                "maxSteps": 5
            }
        }))

        # Receive streaming response
        async for raw in ws:
            msg = json.loads(raw)

            if msg["type"] == "text":
                print(msg["delta"], end="", flush=True)
            elif msg["type"] == "tool_call":
                print(f"\n[Tool] {msg['name']}({msg['args']})")
            elif msg["type"] == "tool_result":
                print(f"[Result] {msg['output'][:100]}")
            elif msg["type"] == "done":
                print(f"\n--- Done. Cost: ${msg['usage']['cost']:.4f}")
                break
            elif msg["type"] == "error":
                print(f"Error: {msg['code']} - {msg['message']}")
                break

asyncio.run(chat())
```

---

## Message flow diagram

A typical chat exchange follows this sequence:

```
Client                              Server
  │                                    │
  │──── chat { id, message } ─────────►│
  │◄─── ack { clientMsgId } ──────────│
  │                                    │
  │◄─── text { delta: "A " } ─────────│
  │◄─── text { delta: "closure " } ───│
  │◄─── text { delta: "is..." } ──────│
  │                                    │
  │◄─── tool_call { name, args } ─────│
  │◄─── tool_result { output } ───────│
  │                                    │
  │◄─── text { delta: "Based on" } ───│
  │◄─── text { delta: "the files" } ──│
  │                                    │
  │◄─── done { usage, finishReason } ─│
  │                                    │
```

::: tip Streaming is real-time
Text deltas arrive as soon as the LLM generates tokens. Tool calls and results are sent inline. The `done` message is always the last message in a generation cycle.
:::
