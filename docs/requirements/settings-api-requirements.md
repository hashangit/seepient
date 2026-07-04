# Seepient Agent Server Settings API — Requirements Document

**Status:** Draft
**Date:** 2026-04-15
**Version:** 0.1.0
**Audience:** Backend engineers implementing the settings API for the Seepient Agent standalone server.

---

## 1. Overview & Goals

### 1.1 Problem

The Seepient Agent server (`src/adapters/server/`) exposes REST and WebSocket endpoints for chat, sessions, models, and skills. There are no endpoints for reading or modifying server configuration. Server operators must edit `~/.seepient/setting.json` or environment variables manually and restart the process. SDK consumers and dashboard UIs have no programmatic way to discover or change settings at runtime.

### 1.2 Goals

1. **Read settings** over REST and WebSocket with sensitive values masked (API keys, passwords).
2. **Write settings** at runtime via partial-update (PATCH) semantics. Changes apply immediately for safe settings; the server signals which changes require a restart.
3. **Provider lifecycle** -- add, update, and remove provider configurations (openai, anthropic, glm, openai-compatible) without a restart.
4. **Real-time sync** -- connected WebSocket clients receive push notifications when settings change, enabling dashboard UIs to stay current without polling.
5. **Schema discovery** -- a JSON Schema endpoint lets tooling auto-generate settings forms and validate inputs client-side.

### 1.3 Design Principles

- **Least privilege.** Read requires `agent:read`. Write requires `admin`. Provider mutations require `admin`.
- **Mask by default, explicit reveal never.** Secret fields (API keys, passwords, webhook secrets) are masked to `sk_***...wxyz` format in all read responses. There is no "reveal" endpoint.
- **Atomic persistence.** Settings writes use write-to-temp-then-rename so a crash mid-write cannot corrupt the config file.
- **Backward compatible.** The existing `setting.json` format, env var overrides, and provider resolution chain remain authoritative. The settings API is a window into that system, not a parallel one.

---

## 2. Settings Categories

All settings are grouped into six categories matching the existing `AppConfig` shape in `src/adapters/cli/config-loader.ts`.

| Category | Key | Fields | Secrets |
|---|---|---|---|
| Providers & Models | `providers` | `provider`, `apiKey`, `baseUrl`, `model`, `models` map | API keys |
| Tools & Services | `tools` | `smtpHost/Port/User/Pass/From`, `tavilyApiKey`, `feishuWebhook/Keyword`, `dingtalkWebhook/Keyword`, `wecomWebhook/Keyword`, `imageApiKey/BaseUrl/Model/Size/Quality/Style/N` | `smtpPass`, `tavilyApiKey`, `imageApiKey`, webhook URLs |
| Agent Behavior | `agent` | `permissionLevel`, `maxSteps`, `autoConfirm`, `systemPrompt` | none |
| Server | `server` | `port`, `host`, `cors`, `sessionTTL`, `maxPermissionLevel` | none |
| Session & Persistence | `persistence` | `sessionDir`, `backendType` | none |
| Skills | `skills` | `skillsPaths`, `skillsDebug`, `skillsBodyLimit` | none |

Secret fields: any field whose name ends in `ApiKey`, `Pass`, `Password`, `Secret`, `Token`, or `Webhook`. These are masked in all read responses.

---

## 3. REST Endpoints Specification

### Common Headers

All authenticated endpoints accept:
- `X-Seepient-API-Key: sk_seepient_...`
- `Authorization: Bearer sk_seepient_...`

All responses are `Content-Type: application/json`.

### Error Response Format

Every error returns:

```json
{
  "error": {
    "code": "STRING_CODE",
    "message": "Human-readable description"
  }
}
```

Standard codes: `UNAUTHORIZED` (401), `FORBIDDEN` (403), `NOT_FOUND` (404), `BAD_REQUEST` (400), `VALIDATION_ERROR` (422), `CONFLICT` (409), `INTERNAL_ERROR` (500).

---

### 3.1 GET /v1/settings

Read all settings across all categories. Secrets are masked.

**Auth:** Required. **Scope:** `agent:read` or `admin`.

**Request:**
```
GET /v1/settings HTTP/1.1
X-Seepient-API-Key: sk_seepient_abc123
```

**Response 200:**
```json
{
  "providers": {
    "default": "openai",
    "openai": {
      "apiKey": "sk_***...wxyz",
      "model": "gpt-5.4"
    },
    "anthropic": {
      "apiKey": "sk_***...abcd",
      "model": "claude-sonnet-4-6-20260320"
    },
    "glm": null,
    "openai-compatible": null
  },
  "tools": {
    "smtpHost": "smtp.example.com",
    "smtpPort": "587",
    "smtpUser": "bot@example.com",
    "smtpPass": "******",
    "smtpFrom": "bot@example.com",
    "tavilyApiKey": "tv_***...efgh",
    "feishuWebhook": "******",
    "feishuKeyword": null,
    "dingtalkWebhook": null,
    "dingtalkKeyword": null,
    "wecomWebhook": null,
    "wecomKeyword": null,
    "imageApiKey": "sk_***...mnop",
    "imageBaseUrl": "https://api.openai.com/v1",
    "imageModel": "gpt-image-1",
    "imageSize": "1024x1024",
    "imageQuality": "medium",
    "imageStyle": null,
    "imageN": 1
  },
  "agent": {
    "permissionLevel": "moderate",
    "maxSteps": 10,
    "autoConfirm": false,
    "systemPrompt": null
  },
  "server": {
    "port": 7337,
    "host": "0.0.0.0",
    "cors": true,
    "sessionTTL": 86400,
    "maxPermissionLevel": "permissive"
  },
  "persistence": {
    "sessionDir": "/home/user/.seepient/sessions",
    "backendType": "file"
  },
  "skills": {
    "skillsPaths": [],
    "skillsDebug": false,
    "skillsBodyLimit": 2097152
  }
}
```

**Error Codes:**
- `401 UNAUTHORIZED` -- missing or invalid API key
- `403 FORBIDDEN` -- key lacks `agent:read` or `admin` scope

---

### 3.2 GET /v1/settings/:category

Read a single category. Secrets are masked.

**Auth:** Required. **Scope:** `agent:read` or `admin`.

**Path Parameters:**
- `category` -- one of: `providers`, `tools`, `agent`, `server`, `persistence`, `skills`

**Request:**
```
GET /v1/settings/agent HTTP/1.1
X-Seepient-API-Key: sk_seepient_abc123
```

**Response 200:**
```json
{
  "agent": {
    "permissionLevel": "moderate",
    "maxSteps": 10,
    "autoConfirm": false,
    "systemPrompt": null
  }
}
```

**Error Codes:**
- `401 UNAUTHORIZED`
- `403 FORBIDDEN`
- `404 NOT_FOUND` -- unknown category name

---

### 3.3 PATCH /v1/settings

Partial update across multiple categories. Only supplied fields are changed; omitted fields are unchanged. Requires `admin` scope.

**Auth:** Required. **Scope:** `admin`.

**Request:**
```
PATCH /v1/settings HTTP/1.1
X-Seepient-API-Key: sk_seepient_admin_key
Content-Type: application/json
```

```json
{
  "agent": {
    "maxSteps": 15,
    "permissionLevel": "strict"
  },
  "tools": {
    "tavilyApiKey": "tvly_new_key_value_here"
  }
}
```

**Response 200:**
```json
{
  "applied": {
    "agent": {
      "maxSteps": 15,
      "permissionLevel": "strict"
    },
    "tools": {
      "tavilyApiKey": "tv_***...here"
    }
  },
  "requiresRestart": false,
  "restartAffected": []
}
```

**Error Codes:**
- `401 UNAUTHORIZED`
- `403 FORBIDDEN` -- key lacks `admin` scope
- `422 VALIDATION_ERROR` -- one or more fields failed validation. Body contains details:
```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "2 field(s) failed validation",
    "details": [
      { "field": "agent.maxSteps", "message": "Must be a positive integer" },
      { "field": "tools.smtpPort", "message": "Must be a valid port number (1-65535)" }
    ]
  }
}
```

---

### 3.4 PATCH /v1/settings/:category

Partial update within a single category.

**Auth:** Required. **Scope:** `admin`.

**Path Parameters:**
- `category` -- one of: `providers`, `tools`, `agent`, `server`, `persistence`, `skills`

**Request:**
```
PATCH /v1/settings/agent HTTP/1.1
X-Seepient-API-Key: sk_seepient_admin_key
Content-Type: application/json
```

```json
{
  "maxSteps": 20,
  "autoConfirm": true
}
```

**Response 200:**
```json
{
  "applied": {
    "maxSteps": 20,
    "autoConfirm": true
  },
  "requiresRestart": false,
  "restartAffected": []
}
```

**Error Codes:**
- `401 UNAUTHORIZED`
- `403 FORBIDDEN`
- `404 NOT_FOUND` -- unknown category
- `422 VALIDATION_ERROR`

---

### 3.5 POST /v1/providers

Add a new provider configuration. If the provider already exists, returns `409 CONFLICT`.

**Auth:** Required. **Scope:** `admin`.

**Request:**
```
POST /v1/providers HTTP/1.1
X-Seepient-API-Key: sk_seepient_admin_key
Content-Type: application/json
```

```json
{
  "type": "openai-compatible",
  "apiKey": "sk-proj-abc123...",
  "baseUrl": "https://llm-proxy.internal:8080/v1",
  "model": "custom-model-v2"
}
```

**Response 201:**
```json
{
  "provider": {
    "type": "openai-compatible",
    "apiKey": "sk_***...123",
    "baseUrl": "https://llm-proxy.internal:8080/v1",
    "model": "custom-model-v2"
  },
  "requiresRestart": false,
  "restartAffected": []
}
```

**Error Codes:**
- `401 UNAUTHORIZED`
- `403 FORBIDDEN`
- `409 CONFLICT` -- provider already configured. Use `PATCH /v1/providers/:type` instead.
```json
{
  "error": {
    "code": "CONFLICT",
    "message": "Provider \"openai-compatible\" is already configured. Use PATCH /v1/providers/openai-compatible to update it."
  }
}
```
- `422 VALIDATION_ERROR` -- missing required fields. `openai-compatible` requires `baseUrl`; all providers require `apiKey`.

---

### 3.6 PATCH /v1/providers/:type

Update an existing provider's configuration. Only supplied fields are changed.

**Auth:** Required. **Scope:** `admin`.

**Path Parameters:**
- `type` -- one of: `openai`, `anthropic`, `glm`, `openai-compatible`

**Request:**
```
PATCH /v1/providers/openai HTTP/1.1
X-Seepient-API-Key: sk_seepient_admin_key
Content-Type: application/json
```

```json
{
  "model": "gpt-5.4-turbo"
}
```

**Response 200:**
```json
{
  "provider": {
    "type": "openai",
    "apiKey": "sk_***...wxyz",
    "model": "gpt-5.4-turbo"
  },
  "requiresRestart": false,
  "restartAffected": []
}
```

**Error Codes:**
- `401 UNAUTHORIZED`
- `403 FORBIDDEN`
- `404 NOT_FOUND` -- provider not configured
```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Provider \"glm\" is not configured. Use POST /v1/providers to add it."
  }
}
```
- `422 VALIDATION_ERROR`

---

### 3.7 DELETE /v1/providers/:type

Remove a provider configuration. If the removed provider was the default, the server switches to the next available provider. If no providers remain, returns `422`.

**Auth:** Required. **Scope:** `admin`.

**Path Parameters:**
- `type` -- one of: `openai`, `anthropic`, `glm`, `openai-compatible`

**Request:**
```
DELETE /v1/providers/glm HTTP/1.1
X-Seepient-API-Key: sk_seepient_admin_key
```

**Response 200:**
```json
{
  "removed": "glm",
  "defaultSwitchedTo": "openai",
  "requiresRestart": false,
  "restartAffected": []
}
```

**Error Codes:**
- `401 UNAUTHORIZED`
- `403 FORBIDDEN`
- `404 NOT_FOUND` -- provider not configured
- `422 VALIDATION_ERROR` -- cannot remove the last configured provider
```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Cannot remove the last configured provider. At least one provider must remain."
  }
}
```

---

### 3.8 GET /v1/settings/schema

Return the JSON Schema for all settings. Used by UI tooling to build dynamic forms and validate inputs client-side.

**Auth:** Required. **Scope:** `agent:read` or `admin`.

**Request:**
```
GET /v1/settings/schema HTTP/1.1
X-Seepient-API-Key: sk_seepient_abc123
```

**Response 200:**
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "Seepient Agent Server Settings",
  "type": "object",
  "properties": {
    "providers": {
      "type": "object",
      "properties": {
        "default": {
          "type": "string",
          "enum": ["openai", "anthropic", "glm", "openai-compatible"],
          "description": "Active provider"
        },
        "openai": {
          "$ref": "#/$defs/providerNoBaseUrl"
        },
        "anthropic": {
          "$ref": "#/$defs/providerNoBaseUrl"
        },
        "glm": {
          "$ref": "#/$defs/providerNoBaseUrl"
        },
        "openai-compatible": {
          "$ref": "#/$defs/providerWithBaseUrl"
        }
      }
    },
    "tools": {
      "type": "object",
      "properties": {
        "smtpHost": { "type": "string", "format": "hostname" },
        "smtpPort": { "type": "string", "pattern": "^[1-9][0-9]{0,4}$" },
        "smtpUser": { "type": "string" },
        "smtpPass": { "type": "string", "writeOnly": true },
        "smtpFrom": { "type": "string", "format": "email" },
        "tavilyApiKey": { "type": "string", "writeOnly": true },
        "feishuWebhook": { "type": "string", "format": "uri", "writeOnly": true },
        "feishuKeyword": { "type": "string" },
        "dingtalkWebhook": { "type": "string", "format": "uri", "writeOnly": true },
        "dingtalkKeyword": { "type": "string" },
        "wecomWebhook": { "type": "string", "format": "uri", "writeOnly": true },
        "wecomKeyword": { "type": "string" },
        "imageApiKey": { "type": "string", "writeOnly": true },
        "imageBaseUrl": { "type": "string", "format": "uri" },
        "imageModel": { "type": "string" },
        "imageSize": { "type": "string", "enum": ["256x256", "512x512", "1024x1024", "1792x1792"] },
        "imageQuality": { "type": "string", "enum": ["low", "medium", "high", "auto"] },
        "imageStyle": { "type": "string", "enum": ["vivid", "natural"] },
        "imageN": { "type": "integer", "minimum": 1, "maximum": 10 }
      }
    },
    "agent": {
      "type": "object",
      "properties": {
        "permissionLevel": { "type": "string", "enum": ["strict", "moderate", "permissive"] },
        "maxSteps": { "type": "integer", "minimum": 1, "maximum": 100 },
        "autoConfirm": { "type": "boolean" },
        "systemPrompt": { "type": "string", "maxLength": 32768 }
      }
    },
    "server": {
      "type": "object",
      "properties": {
        "port": { "type": "integer", "minimum": 1, "maximum": 65535 },
        "host": { "type": "string" },
        "cors": { "type": "boolean" },
        "sessionTTL": { "type": "integer", "minimum": 60 },
        "maxPermissionLevel": { "type": "string", "enum": ["strict", "moderate", "permissive"] }
      }
    },
    "persistence": {
      "type": "object",
      "properties": {
        "sessionDir": { "type": "string" },
        "backendType": { "type": "string", "enum": ["file", "memory"] }
      }
    },
    "skills": {
      "type": "object",
      "properties": {
        "skillsPaths": { "type": "array", "items": { "type": "string" } },
        "skillsDebug": { "type": "boolean" },
        "skillsBodyLimit": { "type": "integer", "minimum": 1024, "maximum": 10485760 }
      }
    }
  },
  "$defs": {
    "providerNoBaseUrl": {
      "type": "object",
      "properties": {
        "apiKey": { "type": "string", "writeOnly": true },
        "model": { "type": "string" }
      },
      "required": ["apiKey"]
    },
    "providerWithBaseUrl": {
      "type": "object",
      "properties": {
        "apiKey": { "type": "string", "writeOnly": true },
        "baseUrl": { "type": "string", "format": "uri" },
        "model": { "type": "string" }
      },
      "required": ["apiKey", "baseUrl"]
    }
  }
}
```

**Error Codes:**
- `401 UNAUTHORIZED`
- `403 FORBIDDEN`

---

## 4. WebSocket Message Types

All new message types use the existing JSON framing. The `type` field discriminates.

### 4.1 Client -> Server: get_settings

Request the current settings snapshot. Equivalent to `GET /v1/settings`.

```jsonc
{
  "type": "get_settings",
  "id": "req-001",               // optional correlation ID
  "category": "agent"            // optional: filter to a single category
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | no | Correlation ID echoed in response |
| `category` | string | no | One of: `providers`, `tools`, `agent`, `server`, `persistence`, `skills`. Omit for all. |

**Behavior:** Server responds with a `settings` message. Requires authenticated WebSocket connection (token validated during upgrade).

---

### 4.2 Client -> Server: update_settings

Apply a partial settings update. Equivalent to `PATCH /v1/settings`.

```jsonc
{
  "type": "update_settings",
  "id": "req-002",
  "settings": {
    "agent": {
      "maxSteps": 20
    },
    "tools": {
      "tavilyApiKey": "tvly_new_key"
    }
  }
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | no | Correlation ID |
| `settings` | object | yes | Partial settings object (same shape as `PATCH /v1/settings` body) |

**Behavior:** Validates, applies, persists, then:
1. Sends `settings_updated` to the requesting client (success or error).
2. Broadcasts `settings_changed` to all other connected clients.
3. Requires `admin` scope on the API key used during WebSocket upgrade.

---

### 4.3 Client -> Server: list_providers

List configured providers (masked). Equivalent to reading `GET /v1/settings` filtered to the `providers` category.

```jsonc
{
  "type": "list_providers",
  "id": "req-003"
}
```

**Behavior:** Server responds with a `providers_list` message.

---

### 4.4 Client -> Server: set_provider

Add or update a provider. Combines `POST` and `PATCH` semantics: if the provider does not exist, it is created; if it exists, the supplied fields are updated.

```jsonc
{
  "type": "set_provider",
  "id": "req-004",
  "provider": {
    "type": "anthropic",
    "apiKey": "sk-ant-new-key...",
    "model": "claude-opus-4-20250918"
  }
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | no | Correlation ID |
| `provider.type` | string | yes | One of: `openai`, `anthropic`, `glm`, `openai-compatible` |
| `provider.apiKey` | string | yes* | Required when creating. Optional when updating (omit to keep existing). |
| `provider.baseUrl` | string | no | Required for `openai-compatible` on create |
| `provider.model` | string | no | Default model for this provider |

**Behavior:** Creates or updates the provider, persists to disk, broadcasts `settings_changed` to all clients. Requires `admin` scope.

---

### 4.5 Client -> Server: remove_provider

Remove a provider configuration. Equivalent to `DELETE /v1/providers/:type`.

```jsonc
{
  "type": "remove_provider",
  "id": "req-005",
  "providerType": "glm"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `providerType` | string | yes | Provider to remove |

**Behavior:** Removes the provider, reassigns default if needed, persists, broadcasts `settings_changed`. Requires `admin` scope.

---

### 4.6 Server -> Client: settings

Response to `get_settings`. Contains the full or filtered settings snapshot with secrets masked.

```jsonc
{
  "type": "settings",
  "id": "req-001",
  "settings": {
    "agent": {
      "permissionLevel": "moderate",
      "maxSteps": 10,
      "autoConfirm": false,
      "systemPrompt": null
    }
  }
}
```

---

### 4.7 Server -> Client: settings_updated

Response to `update_settings`. Confirms what was applied.

```jsonc
{
  "type": "settings_updated",
  "id": "req-002",
  "applied": {
    "agent": { "maxSteps": 20 },
    "tools": { "tavilyApiKey": "tv_***...key" }
  },
  "requiresRestart": false,
  "restartAffected": []
}
```

If validation fails:

```jsonc
{
  "type": "settings_updated",
  "id": "req-002",
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "1 field(s) failed validation",
    "details": [
      { "field": "agent.maxSteps", "message": "Must be a positive integer" }
    ]
  }
}
```

---

### 4.8 Server -> Client: providers_list

Response to `list_providers`.

```jsonc
{
  "type": "providers_list",
  "id": "req-003",
  "providers": {
    "default": "openai",
    "openai": {
      "apiKey": "sk_***...wxyz",
      "model": "gpt-5.4"
    },
    "anthropic": {
      "apiKey": "sk_***...abcd",
      "model": "claude-sonnet-4-6-20260320"
    },
    "glm": null,
    "openai-compatible": null
  }
}
```

---

### 4.9 Server -> Client: settings_changed (push notification)

Broadcast to all connected WebSocket clients (except the originator) when settings change. Contains a summary of what changed, not the full snapshot. Clients should issue `get_settings` if they need the full state.

```jsonc
{
  "type": "settings_changed",
  "changedCategories": ["agent", "tools"],
  "changedFields": ["agent.maxSteps", "tools.tavilyApiKey"],
  "requiresRestart": false,
  "restartAffected": [],
  "timestamp": "2026-04-15T10:30:00.000Z"
}
```

| Field | Type | Description |
|---|---|---|
| `changedCategories` | string[] | Top-level categories affected |
| `changedFields` | string[] | Dot-notation paths of changed fields |
| `requiresRestart` | boolean | Whether any change requires a server restart |
| `restartAffected` | string[] | Fields that require restart (empty if `requiresRestart` is false) |
| `timestamp` | string | ISO 8601 timestamp of the change |

---

## 5. Security Requirements

### 5.1 Scope Matrix

| Operation | REST | WebSocket | Required Scope |
|---|---|---|---|
| Read all settings | `GET /v1/settings` | `get_settings` | `agent:read` or `admin` |
| Read category | `GET /v1/settings/:cat` | `get_settings` with `category` | `agent:read` or `admin` |
| Read schema | `GET /v1/settings/schema` | -- | `agent:read` or `admin` |
| Update settings | `PATCH /v1/settings` | `update_settings` | `admin` |
| Update category | `PATCH /v1/settings/:cat` | `update_settings` | `admin` |
| Add provider | `POST /v1/providers` | `set_provider` | `admin` |
| Update provider | `PATCH /v1/providers/:type` | `set_provider` | `admin` |
| Remove provider | `DELETE /v1/providers/:type` | `remove_provider` | `admin` |

### 5.2 Secret Masking

Fields are classified as secret by name pattern. The masking function follows the existing `maskSecret()` convention from `src/adapters/cli/config-loader.ts`:

- Strings shorter than 8 characters are replaced with `"******"`.
- Strings 8+ characters show the first 3 and last 4 characters: `"sk_...wxyz"`.

Secret field detection rules (applied in settings response serialization):

| Pattern | Examples |
|---|---|
| Ends with `ApiKey` | `apiKey`, `tavilyApiKey`, `imageApiKey` |
| Ends with `Pass` or `Password` | `smtpPass` |
| Ends with `Webhook` | `feishuWebhook`, `dingtalkWebhook`, `wecomWebhook` |
| Ends with `Secret` or `Token` | (reserved for future use) |

Masking applies to:
- All `GET /v1/settings` responses
- All `settings` and `providers_list` WebSocket messages
- The `applied` object in `PATCH` responses and `settings_updated` messages
- The `provider` object in `POST/PATCH /v1/providers` responses

Masking does NOT apply to the incoming write request body. The server receives the plaintext value, validates it, and stores it. Only the response masks it.

### 5.3 Rate Limiting

Settings endpoints have separate rate limits from chat/session endpoints to prevent brute-force probing of secret values:

| Endpoint | Rate Limit |
|---|---|
| `GET /v1/settings` | 30 requests/minute per API key |
| `GET /v1/settings/:category` | 60 requests/minute per API key |
| `PATCH /v1/settings` | 10 requests/minute per API key |
| `PATCH /v1/settings/:category` | 10 requests/minute per API key |
| `POST /v1/providers` | 5 requests/minute per API key |
| `PATCH /v1/providers/:type` | 5 requests/minute per API key |
| `DELETE /v1/providers/:type` | 5 requests/minute per API key |
| `GET /v1/settings/schema` | 10 requests/minute per API key |

Rate limit headers on every response:
```
X-RateLimit-Limit: 30
X-RateLimit-Remaining: 28
X-RateLimit-Reset: 1713172200
```

When exceeded, return `429 Too Many Requests`:
```json
{
  "error": {
    "code": "RATE_LIMITED",
    "message": "Rate limit exceeded. Retry after 45 seconds.",
    "retryAfter": 45
  }
}
```

### 5.4 Audit Logging

Every settings write operation is logged to `~/.seepient/settings-audit.jsonl` (one JSON object per line). Each entry:

```json
{
  "timestamp": "2026-04-15T10:30:00.000Z",
  "action": "update_settings",
  "apiKeyLabel": "dashboard-key",
  "apiKeyHash": "a1b2c3d4e5f6",
  "changedFields": ["agent.maxSteps", "tools.tavilyApiKey"],
  "source": "rest",
  "success": true
}
```

| Field | Description |
|---|---|
| `action` | One of: `update_settings`, `add_provider`, `update_provider`, `remove_provider` |
| `apiKeyLabel` | The `label` field from the `ApiKeyEntry` |
| `apiKeyHash` | First 16 hex chars of SHA-256 of the API key |
| `changedFields` | Dot-notation paths of fields that were modified |
| `source` | `rest` or `websocket` |
| `success` | `true` if applied, `false` if validation failed |
| `errorMessage` | Included only when `success` is `false` |

Failed validation attempts are also logged (with `success: false`) to detect probing.

---

## 6. Validation & Error Handling

### 6.1 Validation Rules

| Field | Rule |
|---|---|
| `providers.*.apiKey` | Non-empty string. Min 8 characters. |
| `providers.*.baseUrl` | Must be a valid URL with `http:` or `https:` scheme. Required for `openai-compatible`. |
| `providers.*.model` | Non-empty string if provided. |
| `providers.default` | Must reference a configured provider. |
| `tools.smtpPort` | String representation of integer 1-65535. |
| `tools.smtpFrom` | Valid email format if provided. |
| `tools.imageSize` | One of: `256x256`, `512x512`, `1024x1024`, `1792x1792`. |
| `tools.imageN` | Integer 1-10. |
| `agent.permissionLevel` | One of: `strict`, `moderate`, `permissive`. |
| `agent.maxSteps` | Integer 1-100. |
| `agent.systemPrompt` | String, max 32768 characters. |
| `server.port` | Integer 1-65535. **Restart required.** |
| `server.host` | Non-empty string. **Restart required.** |
| `server.cors` | Boolean. |
| `server.sessionTTL` | Integer >= 60 (seconds). **Restart required if decreased below current min session age.** |
| `server.maxPermissionLevel` | One of: `strict`, `moderate`, `permissive`. |
| `persistence.sessionDir` | Valid filesystem path. **Restart required.** |
| `persistence.backendType` | One of registered backend types (default: `file`, `memory`). **Restart required.** |
| `skills.skillsBodyLimit` | Integer 1024-10485760. |

### 6.2 Restart Classification

Settings are classified as **safe** (apply immediately) or **restart-required** (take effect only after server restart).

**Safe (hot-reload):**
- All `providers` changes (API keys, models, base URLs, default provider)
- All `tools` changes
- `agent.permissionLevel`, `agent.maxSteps`, `agent.autoConfirm`, `agent.systemPrompt`
- `server.cors`, `server.maxPermissionLevel`, `server.sessionTTL` (increase only)
- `skills.*`

**Restart-required:**
- `server.port`
- `server.host`
- `server.sessionTTL` (decrease)
- `persistence.sessionDir`
- `persistence.backendType`

When a PATCH request includes restart-required fields, the response includes:
```json
{
  "requiresRestart": true,
  "restartAffected": ["server.port"]
}
```

The change is persisted to disk and applied to the in-memory config. The server continues running with the old value until restarted. This lets operators batch multiple restart-required changes and restart once.

### 6.3 Error Handling

- **Validation failure:** Reject the entire request. Do not apply any fields, even valid ones. This is atomic: either all changes apply or none do.
- **Persistence failure:** If the config file cannot be written (disk full, permissions error), return `500 INTERNAL_ERROR` with message `"Failed to persist settings"`. The in-memory state is not updated.
- **Concurrent writes:** Process settings writes serially per a single in-memory write lock. If a write is in progress, subsequent writes wait (do not reject). Timeout: 5 seconds, after which return `503 SERVICE_UNAVAILABLE`.

---

## 7. Real-Time Configuration Sync

### 7.1 Broadcast Mechanism

When settings change (via REST or WebSocket), the server:

1. Acquires the write lock.
2. Validates the update.
3. Applies to in-memory state.
4. Persists to disk (atomic write-to-temp-then-rename).
5. Releases the write lock.
6. Broadcasts `settings_changed` to all WebSocket clients except the originator.

The broadcast is best-effort. If a WebSocket connection is slow or broken, the broadcast is skipped for that connection without blocking others.

### 7.2 Concurrency

Settings writes are serialized through a single async mutex (write lock). Reads are not locked; they return the current in-memory snapshot. This means a read concurrent with a write may return either the old or new state, which is acceptable.

The mutex must be the same for REST and WebSocket to prevent a REST write and a WebSocket write from interleaving.

### 7.3 Restart Signaling

When `settings_changed` includes `requiresRestart: true`, the server also sets an internal flag `restartPending: true`. The `GET /v1/health` endpoint includes this flag:

```json
{
  "status": "ok",
  "version": "0.3.0",
  "uptime": 3600,
  "restartPending": true,
  "restartPendingFields": ["server.port"]
}
```

Clients can poll health or receive `settings_changed` push to learn about pending restarts.

---

## 8. Persistence Requirements

### 8.1 File Format

Settings are persisted to the existing `setting.json` file at either:
- Local: `.seepient/setting.json` (project-level)
- Global: `~/.seepient/setting.json` (user-level)

The server resolves the active config path at startup (local if it exists, else global) and uses that single path for all writes.

### 8.2 Atomic Writes

Every write follows this sequence:

1. Serialize settings to JSON.
2. Write to a temporary file in the same directory: `setting.json.tmp.${pid}.${random}`.
3. `fs.rename()` the temp file to `setting.json`.

`rename()` is atomic on POSIX and NTFS. If the process crashes between steps 2 and 3, the original file is untouched.

### 8.3 File Permissions

- The config file is created with mode `0o600` (owner read/write only).
- The temp file is also `0o600`.
- On startup, if the config file has overly permissive modes (e.g., `0o644`), log a warning:
  ```
  [seepient] WARNING: setting.json has mode 0644. Recommend 0600 to protect API keys.
  ```

### 8.4 Corruption Recovery

If `setting.json` fails to parse on server startup:

1. Log the error with the file path.
2. Check for `.seepient/setting.json.bak` (previous version). If it exists and parses, use it.
3. If no backup exists, start with an empty config. Providers resolve from environment variables only.
4. Do not automatically overwrite the corrupt file. Log: `[seepient] Config file corrupt. Using environment variables. Manual fix required: ~/.seepient/setting.json`.

After every successful write, the previous file is preserved as `.seepient/setting.json.bak` before the atomic rename.

---

## 9. Non-Functional Requirements

### 9.1 Performance

| Metric | Target |
|---|---|
| `GET /v1/settings` latency | < 5ms (in-memory read) |
| `PATCH /v1/settings` latency | < 50ms (includes disk write) |
| `GET /v1/settings/schema` latency | < 2ms (static response) |
| WebSocket `settings_changed` broadcast | < 10ms to all connected clients |

### 9.2 Concurrency

- The server must handle settings reads from 100 concurrent clients without blocking.
- Settings writes are serialized but must not block reads.
- The write lock must not be held during WebSocket broadcast (broadcast happens after release).

### 9.3 Backward Compatibility

- The settings API does not change the existing `setting.json` format. It reads and writes the same schema that the CLI config loader uses.
- Environment variable overrides remain in effect. A value set via env var is visible in the API but is not overwritten to disk by a read. On write, the new value is persisted to `setting.json` and takes precedence over the env var until the server restarts (env vars are re-evaluated at startup).
- Existing REST endpoints (`/v1/health`, `/v1/models`, `/v1/skills`, `/v1/chat`, `/v1/sessions/:id`) and WebSocket message types are unchanged.
- The new endpoints are additive. Servers that do not receive settings requests function identically to today.

### 9.4 Zero-Downtime Safe Changes

Safe settings changes (see section 6.2) apply to the in-memory state immediately without interrupting in-flight chat requests. A request that is mid-stream when settings change completes with the old provider/model configuration. The next request uses the new configuration.

---

## 10. Out of Scope (v1)

The following are explicitly excluded from the initial implementation:

1. **Settings version history / rollback.** The `.bak` file preserves one previous version only. Full history and rollback are deferred to v2.
2. **Multi-file config merge via API.** The server does not expose or modify the merge order (env > local > global). It writes to whichever config path is active.
3. **Dynamic schema registration.** The schema endpoint returns a static schema. Custom tools and backends cannot inject new schema fields at runtime.
4. **Settings encryption at rest.** API keys are stored as plaintext in `setting.json` (protected by file permissions). Encrypted storage is deferred to v2.
5. **WebSocket settings diff streaming.** The `settings_changed` notification contains field paths, not field values. Clients must request a full snapshot if they need values.
6. **Per-client settings overrides.** All clients see the same settings. There is no mechanism for per-API-key or per-connection settings overrides.
7. **Server self-restart.** The API signals that a restart is needed but does not trigger one. Process orchestration (systemd, Docker, etc.) handles restarts.
8. **Import/export of settings.** Bulk import from a file or export to a file is not in v1.
9. **Settings migration between versions.** The server does not auto-migrate older config formats. The existing `migrateLegacyFormat()` function in `config-loader.ts` runs at startup only.
10. **OAuth / RBAC beyond existing scopes.** The current three-scope model (`agent:run`, `agent:read`, `admin`) is sufficient. Fine-grained permissions (e.g., "can update tools but not providers") are deferred.

---

## Appendix A: WebSocket Message Type Registration

New `type` discriminators to add to `ClientMessage` and `ServerMessage` unions in `src/adapters/server/ws-types.ts`:

**ClientMessage additions:**
- `"get_settings"`
- `"update_settings"`
- `"list_providers"`
- `"set_provider"`
- `"remove_provider"`

**ServerMessage additions:**
- `"settings"`
- `"settings_updated"`
- `"providers_list"`
- `"settings_changed"`

---

## Appendix B: REST Route Registration

New route patterns to add to `matchRoute()` in `src/adapters/server/rest.ts`:

```
GET    /v1/settings
GET    /v1/settings/:category
PATCH  /v1/settings
PATCH  /v1/settings/:category
POST   /v1/providers
PATCH  /v1/providers/:type
DELETE /v1/providers/:type
GET    /v1/settings/schema
```

CORS headers must also include `PATCH` and `DELETE` in `Access-Control-Allow-Methods`. Current code only lists `GET, POST, OPTIONS`.
