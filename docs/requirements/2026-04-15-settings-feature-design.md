# Settings Feature Design

**Date**: 2026-04-15
**Status**: Draft
**Scope**: CLI, SDK, Server adapters

## Problem

Users have no way to view or change settings at runtime. Config is file-only, loaded at startup, with no interactive management. The gap exists across all three adapters:

- **CLI**: No `/settings` command. Users edit JSON files manually or rerun `/setup`.
- **SDK**: Only provider config helpers (`configureProviders`, `provider()`). No general settings API.
- **Server**: Zero settings REST endpoints.

## User Personas

| Persona | Context | Primary Actions |
|---------|---------|----------------|
| CLI User | Terminal REPL | View config, change settings mid-session, guided setup |
| SDK Developer | Library consumer | Read/write config programmatically, subscribe to changes |
| Server Admin | Standalone server | Manage config via HTTP, no REPL access |
| End User (future) | GUI consumer | Simple toggles, guided flows |

## Design Decisions

1. **Unified Core** — single `SettingsManager` in core, adapter facades for CLI/SDK/Server
2. **Wizard-based CLI** — interactive `/settings` with guided category flows
3. **Hot-apply** — all changes take effect immediately, no restart required
4. **Schema-driven** — settings defined in a schema, validation and defaults automatic
5. **Secret masking** — API keys and credentials never returned in full

## Settings Categories

Six categories, organized by user concern:

| Category | Properties | When visible |
|----------|-----------|-------------|
| Provider & Model | `provider`, `model`, per-provider `apiKey`/`baseUrl`/`model` | Always |
| Permissions & Safety | `permissionLevel`, `autoConfirm` | Always |
| Tools & Integrations | Image gen config, email SMTP, `tavilyApiKey` | Always |
| Notifications | Feishu, DingTalk, WeCom webhooks | Always |
| Skills | Discovery paths, allowed/blocked skills | Always |
| Server | Port, CORS, session TTL, concurrency, API scopes | Server mode only |

## CLI: `/settings` Wizard

### Entry point

User types `/settings` in the REPL. The wizard displays current state and a category menu:

```
/settings
┌──────────────────────────────────────────────────┐
│  Current Settings                                 │
│                                                   │
│  Provider: anthropic       Model: claude-sonnet   │
│  Permissions: moderate     Auto-confirm: off      │
│                                                   │
│  ? What would you like to change?                 │
│    ❯ Provider & Model                             │
│      Permissions & Safety                         │
│      Tools & Integrations                         │
│      Notifications                                │
│      Skills                                       │
│      View full config (JSON)                      │
│      Reset to defaults                            │
│      Done                                         │
└──────────────────────────────────────────────────┘
```

### Category flow (example: Provider & Model)

```
? Provider & Model
  Current provider: anthropic
  Current model: claude-sonnet-4-5

  ? Change provider?
    ❯ Keep anthropic
      openai
      glm
      openai-compatible

  ? Change model?
    ❯ Keep claude-sonnet-4-5-20250929
      claude-haiku-4-5-20251001
      claude-opus-4-6-20250920

  ✓ Provider & model updated.
  Returning to main menu...
```

### Utility options

- **View full config (JSON)** — prints masked JSON to console
- **Reset to defaults** — confirms, then resets all settings to schema defaults
- **Done** — exits the wizard

### Hot-apply behavior

When the wizard writes a setting:
1. `SettingsManager.set()` validates and persists the change
2. Core fires `settings:changed` event
3. Running agent loop re-resolves provider/model/permissions
4. User continues chatting with the new configuration

## SDK: Programmatic API

```typescript
import { settings } from 'seepient'

// Read
settings.get('provider')           // → 'anthropic'
settings.get('models.anthropic')   // → { apiKey: '***', model: 'sonnet' }
settings.list()                    // → Record<string, unknown>
settings.listByCategory()          // → Record<Category, Record<string, unknown>>

// Write (hot-apply)
settings.set('model', 'sonnet')
settings.apply({
  provider: 'openai',
  model: 'gpt-4o',
  permissionLevel: 'moderate',
})

// Subscribe
settings.onChange((key, value) => { /* react */ })

// Reset
settings.reset('model')            // → reset one key
settings.resetAll()                 // → reset everything
```

All write operations validate against the schema and throw `SeepientError` on invalid values. Secrets are masked in `get()` and `list()` output.

## Server: REST API

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/settings` | All settings (secrets masked) |
| GET | `/v1/settings/:category` | Settings for one category |
| PATCH | `/v1/settings` | Batch update `{ key: value, ... }` |
| DELETE | `/v1/settings/:key` | Reset one key to default |

All endpoints require authentication with `settings` scope.

### WebSocket push

When settings change via REST, the server pushes a `settings:updated` event to all connected WebSocket clients:

```json
{ "type": "settings:updated", "data": { "key": "model", "value": "sonnet" } }
```

### Error responses

- `400` — invalid value (includes expected type/enum)
- `403` — missing `settings` scope
- `500` — persistence failure (file system error)

## Core Architecture

### File structure

```
src/core/settings-manager.ts    ← SettingsManager class
src/core/settings-schema.ts     ← Schema definitions, defaults, validation
src/adapters/cli/commands/settings.ts   ← Interactive wizard
src/adapters/sdk/settings.ts    ← SDK facade
src/adapters/server/settings.ts ← REST routes
```

### SettingsManager

Singleton per process. Responsibilities:

1. **Load** — reads merged config (env vars > project `.seepient/setting.json` > global `~/.seepient/setting.json` > schema defaults)
2. **Get/Set** — validates against schema, applies change, persists to appropriate config file
3. **Hot-apply** — fires `settings:changed` event for running session to pick up
4. **Mask** — returns secrets as `***` or `sk-...abc` in all output
5. **Validate** — rejects invalid values with structured error messages

### Settings schema

Each setting entry defines:

```typescript
interface SettingDefinition {
  key: string              // dot-path: "models.anthropic.apiKey"
  category: Category       // one of the 6 categories
  type: 'string' | 'number' | 'boolean' | 'enum' | 'object'
  enum?: string[]          // for enum type
  default?: unknown        // default value
  secret?: boolean         // mask in output
  description: string      // human-readable
  validate?: (v: unknown) => boolean  // custom validation
}
```

### Event flow

```
User changes setting (wizard / SDK / REST)
  → SettingsManager.set(key, value)
    → Validate against schema
    → Persist to config file (0600)
    → Emit 'settings:changed' { key, value }
      → Agent loop re-resolves provider/model/permissions
      → SDK onChange callbacks fire
      → Server WebSocket push to clients
```

### Persistence

- Writes to the same `.seepient/setting.json` format (no new config format)
- Respects the existing merge chain — writes go to the most specific file (project config if it exists, otherwise global)
- File permissions: 0600 (owner read/write only)
- In-memory state persists even if file write fails (warn but don't crash)

### Concurrent writes (server)

Serial write queue — last-write-wins. Read operations are lock-free.

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Invalid value | Return error with expected type/enum, no change applied |
| File permission error | Warn, keep in-memory state, don't crash |
| Concurrent writes | Serial queue, last-write-wins |
| Missing setting key | Return `undefined` for `get()`, error for `set()` with unknown key |
| Schema validation failure | `SeepientError` with `code: 'SETTINGS_INVALID'` |

## What's Out of Scope

- Display & appearance settings (theme, verbose) — can be added later
- Session & history settings (transcript retention) — can be added later
- Interactive setup wizard redesign — `/setup` remains as-is for first-time setup
- Settings import/export
- Settings profiles or presets
- Enterprise managed settings (locked/override layer)
