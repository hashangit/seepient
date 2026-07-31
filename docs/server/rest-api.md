---
title: REST API Reference
description: Complete reference for all Seepient Agent Server REST endpoints with request/response examples.
---

# REST API Reference

All REST endpoints return JSON with `Content-Type: application/json`. Authentication is via API key unless noted otherwise.

## Base URL

```
http://localhost:7337
```

## Authentication

Pass your API key in one of two ways:

```
X-Seepient-API-Key: sk_seepient_...
```

```
Authorization: Bearer sk_seepient_...
```

See [Authentication](/server/authentication) for key generation and scopes.

---

## Health Check

### `GET /v1/health`

Returns server status. **No authentication required.**

#### Example

```bash
curl http://localhost:7337/v1/health
```

#### Response

```json
{
  "status": "ok",
  "version": "0.1.1",
  "uptime": 3600
}
```

| Field | Type | Description |
|---|---|---|
| `status` | `string` | Always `"ok"` when the server is running |
| `version` | `string` | Seepient Agent package version |
| `uptime` | `number` | Seconds since server started |

---

## List Models

### `GET /v1/models`

Returns all available models from your configured inference providers (OpenAI, Anthropic, GLM). Seepient Agent does not host these models — it forwards requests to the provider APIs. **Requires a valid API key.**

#### Example

```bash
curl http://localhost:7337/v1/models \
  -H "X-Seepient-API-Key: sk_seepient_..."
```

#### Response

```json
{
  "models": {
    "openai": ["gpt-5.4", "gpt-5.4-pro", "gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.3-instant", "gpt-5.3-codex", "o3", "o3-mini"],
    "anthropic": ["claude-sonnet-4-6-20260320", "claude-opus-4-6-20260320", "claude-haiku-4-5-20251001"],
    "glm": ["opus", "sonnet", "haiku"],
    "openai-compatible": ["(user-configured)"]
  }
}
```

| Field | Type | Description |
|---|---|---|
| `models` | `object` | Map of provider names to model ID arrays |

---

## List Skills

### `GET /v1/skills`

Returns metadata for all registered skills. **Requires a valid API key.**

#### Example

```bash
curl http://localhost:7337/v1/skills \
  -H "X-Seepient-API-Key: sk_seepient_..."
```

#### Response

```json
{
  "skills": [
    {
      "name": "code-review",
      "description": "Review code for quality, security, and best practices",
      "tags": ["code", "review", "quality"]
    },
    {
      "name": "summarize",
      "description": "Summarize text or documents concisely",
      "tags": ["text", "summary"]
    }
  ]
}
```

| Field | Type | Description |
|---|---|---|
| `skills` | `array` | Array of skill metadata objects |
| `skills[].name` | `string` | Skill identifier |
| `skills[].description` | `string` | Human-readable description |
| `skills[].tags` | `string[]` | Tags for categorization |

---

## Chat

### `POST /v1/chat`

Execute a one-shot agent interaction. **Requires API key with `agent:run` scope.**

#### Request body

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `message` | `string` | Yes | -- | The user prompt |
| `model` | `string` | No | Provider default | Model ID to use |
| `provider` | `string` | No | Server default | Provider: `openai`, `anthropic`, `glm`, `openai-compatible` |
| `tools` | `string[]` | No | `[]` | Tool names or group names to enable |
| `maxSteps` | `number` | No | `10` | Maximum agent loop iterations |
| `skills` | `string[]` | No | `[]` | Skill names to activate |

#### Example

```bash
curl -X POST http://localhost:7337/v1/chat \
  -H "Content-Type: application/json" \
  -H "X-Seepient-API-Key: sk_seepient_..." \
  -d '{
    "message": "What files are in the current directory?",
    "provider": "anthropic",
    "tools": ["execute_shell_command"],
    "maxSteps": 5
  }'
```

#### Success response (200)

```json
{
  "text": "The current directory contains the following files:\n- README.md\n- package.json\n- src/",
  "toolCalls": [
    {
      "id": "call_abc123",
      "name": "execute_shell_command",
      "arguments": { "command": "ls" },
      "result": "README.md\npackage.json\nsrc/"
    }
  ],
  "usage": {
    "promptTokens": 245,
    "completionTokens": 87,
    "totalTokens": 332,
    "cost": 0.0032
  },
  "finishReason": "stop"
}
```

#### Error responses

| Status | Code | When |
|---|---|---|
| 400 | `BAD_REQUEST` | Missing or invalid `message` field |
| 401 | `UNAUTHORIZED` | Missing or invalid API key |
| 403 | `FORBIDDEN` | Key lacks `agent:run` scope |
| 500 | `GENERATION_ERROR` | Text generation failed (retryable) |
| 502 | `PROVIDER_ERROR` | LLM provider failure (retryable) |

#### Response fields

| Field | Type | Description |
|---|---|---|
| `text` | `string` | The generated text response |
| `toolCalls` | `array` | Tool invocations made during generation |
| `toolCalls[].id` | `string` | Unique call identifier |
| `toolCalls[].name` | `string` | Tool name that was invoked |
| `toolCalls[].arguments` | `object` | Arguments passed to the tool |
| `toolCalls[].result` | `string` | Tool execution result |
| `usage` | `object` | Token usage and cost breakdown |
| `usage.promptTokens` | `number` | Tokens in the prompt |
| `usage.completionTokens` | `number` | Tokens in the completion |
| `usage.totalTokens` | `number` | Total tokens consumed |
| `usage.cost` | `number` | Estimated cost in USD |
| `finishReason` | `string` | `"stop"`, `"tool_calls"`, `"length"`, or `"error"` |

---

## Get Session

### `GET /v1/sessions/:id`

Retrieve a session by its ID. **Requires API key with `agent:read` scope.**

#### Example

```bash
curl http://localhost:7337/v1/sessions/550e8400-e29b-41d4-a716-446655440000 \
  -H "X-Seepient-API-Key: sk_seepient_..."
```

#### Success response (200)

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
      "content": "A closure is a function that has access to...",
      "timestamp": 1712505602000
    }
  ],
  "createdAt": 1712505600000,
  "updatedAt": 1712505602000,
  "provider": "anthropic",
  "model": "claude-sonnet-4-6-20260320"
}
```

#### Error responses

| Status | Code | When |
|---|---|---|
| 401 | `UNAUTHORIZED` | Missing or invalid API key |
| 403 | `FORBIDDEN` | Key lacks `agent:read` scope |
| 404 | `NOT_FOUND` | Session expired or does not exist |

#### Response fields

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Session UUID |
| `messages` | `array` | Ordered message history |
| `messages[].id` | `string` | Message UUID |
| `messages[].role` | `string` | `"user"` or `"assistant"` |
| `messages[].content` | `string` | Message text content |
| `messages[].timestamp` | `number` | Unix timestamp in milliseconds |
| `createdAt` | `number` | Session creation timestamp (ms) |
| `updatedAt` | `number` | Last update timestamp (ms) |
| `provider` | `string` | LLM provider used |
| `model` | `string` | Model ID used |

---

## Error format

All errors follow a consistent JSON structure:

```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Missing or invalid API key"
  }
}
```

::: tip Retryable errors
`PROVIDER_ERROR` and `GENERATION_ERROR` are retryable. Implement exponential backoff with a maximum of 3 retries.
:::
