# `/settings` Slash Command — Requirements Document

**Status:** Draft
**Date:** 2026-04-15
**Author:** Product Engineering
**Scope:** CLI adapter (`src/adapters/cli/`)

---

## 1. Overview & Goals

### 1.1 Problem

Seepient Agent exposes 50+ configuration properties across providers, tools, agent behavior, and services. Today, users must edit JSON files by hand or rerun the full setup wizard to change a single value. The `/models` command proves runtime config editing is viable for provider settings, but there is no equivalent for the remaining categories (email, search, notifications, permissions, image generation, etc.).

Users have no way to:
- View which settings are active and where they come from (global, project, env var).
- Change one setting without restarting the REPL.
- Understand which settings take effect immediately vs. which require a restart.

### 1.2 Goals

1. Provide a single slash command (`/settings`) to view and edit all configurable properties at runtime.
2. Surface the origin (global config, project config, env var, default) for every setting value.
3. Support both interactive browsing (category menus) and direct CLI-style operations (`get`, `set`, `reset`).
4. Reuse existing infrastructure (`saveConfig()`, `loadMergedConfig()`, `maskSecret()`, setup wizard) — no new persistence layer.
5. Maintain parity with `/models` for provider/model operations so the two commands are complementary, not duplicative.

### 1.3 Success Criteria

- [ ] User can type `/settings` and see a categorized overview of all settings with status indicators.
- [ ] User can type `/settings get providers.openai.apiKey` and see the masked value with its origin.
- [ ] User can type `/settings set smtpHost smtp.gmail.com` and have it persisted immediately.
- [ ] User can type `/settings reset tavilyApiKey` and have it removed from config.
- [ ] User can type `/settings wizard` to re-enter the full setup wizard.
- [ ] Settings that require restart are clearly marked.
- [ ] Secret fields are never printed in plaintext during `get` or `list`.
- [ ] Existing `/models` command continues to work unchanged.
- [ ] All existing config files load without modification (backward compatibility).

---

## 2. Command Syntax & Subcommands

### 2.1 Full Syntax

```
/settings                                    Interactive category browser
/settings list [category]                    List settings in a category (or all)
/settings get <dot.key>                      Show current value + origin
/settings set <dot.key> <value>              Set a value (interactive for secrets)
/settings reset <dot.key>                    Remove a value (revert to default)
/settings edit [category]                    Open guided editor for a category
/settings wizard                             Re-run the full setup wizard
/settings export                             Print full merged config as JSON
/settings help                               Show /settings usage
```

**Registration in the command registry:**

```
name: 'settings'
aliases: ['config', 'setting']
description: 'View and edit configuration'
tier: Tier 2 — Configuration & Discovery
```

**Rationale for aliases:** `config` is the most common alias in competitors (Claude Code, OpenClaw). `setting` handles singular/plural confusion.

### 2.2 Subcommand Details

| Subcommand | Args | Behavior |
|---|---|---|
| *(none)* | — | Launch interactive category menu (Section 3). |
| `list` | Optional category name | Print settings table for the given category, or all categories if omitted. Non-interactive. |
| `get` | `<dot.key>` (required) | Print the current value, its origin scope, and default value. Masked for secrets. |
| `set` | `<dot.key> <value>` (both required) | Validate and persist the new value. For secret fields, if `<value>` is omitted or is `-`, prompt with masked input. |
| `reset` | `<dot.key>` (required) | Delete the key from whichever config file owns it. Prints confirmation. |
| `edit` | Optional category name | Launch the guided category editor (inquirer-based form for all fields in that category). |
| `wizard` | — | Delegate to `runSetup()` from `setup.ts`. Identical to first-run wizard. |
| `export` | — | Print the full merged config as pretty-printed JSON. Secrets masked. |
| `help` | — | Print `/settings` usage information. |

### 2.3 Dot-Notation Keys

Settings are addressed using dot-notation that mirrors the JSON structure of `setting.json`. The mapping is:

```
providers.openai.apiKey          → config.models.openai.apiKey
providers.openai.model           → config.models.openai.model
providers.anthropic.apiKey       → config.models.anthropic.apiKey
providers.anthropic.model        → config.models.anthropic.model
providers.glm.apiKey             → config.models.glm.apiKey
providers.glm.model              → config.models.glm.model
providers.openai-compat.apiKey   → config.models['openai-compatible'].apiKey
providers.openai-compat.baseUrl  → config.models['openai-compatible'].baseUrl
providers.openai-compat.model    → config.models['openai-compatible'].model
provider                         → config.provider
image.apiKey                     → config.imageApiKey
image.baseUrl                    → config.imageBaseUrl
image.model                      → config.imageModel
image.size                       → config.imageSize
image.quality                    → config.imageQuality
image.style                      → config.imageStyle
image.n                          → config.imageN
smtp.host                        → config.smtpHost
smtp.port                        → config.smtpPort
smtp.user                        → config.smtpUser
smtp.pass                        → config.smtpPass
smtp.from                        → config.smtpFrom
search.tavilyApiKey              → config.tavilyApiKey
notifications.feishu.webhook     → config.feishuWebhook
notifications.feishu.keyword     → config.feishuKeyword
notifications.dingtalk.webhook   → config.dingtalkWebhook
notifications.dingtalk.keyword   → config.dingtalkKeyword
notifications.wecom.webhook      → config.wecomWebhook
notifications.wecom.keyword      → config.wecomKeyword
agent.permissionLevel            → config.permissionLevel
agent.autoConfirm                → config.autoConfirm
```

**REQ-2.3.1:** The key resolver MUST translate dot-notation to the flat `AppConfig` structure. A static mapping table (`SETTINGS_MAP`) defines this translation in both directions.

**REQ-2.3.2:** Unknown keys MUST produce a clear error: `Unknown setting: <key>. Use /settings list to see available keys.`

**REQ-2.3.3:** Keys are case-sensitive. No fuzzy matching.

---

## 3. Interactive Category Menu

### 3.1 Behavior When User Types `/settings` (No Arguments)

**REQ-3.1.1:** When invoked without arguments in interactive mode (TTY), `/settings` displays a category selection menu using `inquirer` select prompt.

**REQ-3.1.2:** The menu presents these six categories:

```
  Providers & Models     [4 configured / 4 total]
  Image Generation       [partially configured]
  Email (SMTP)           [not configured]
  Web Search             [configured]
  Notifications          [partially configured]
  Agent Behavior         [configured]
```

**REQ-3.1.3:** Each category shows a status indicator:
- `[configured]` — All required fields have non-empty values.
- `[partially configured]` — Some fields are set, others are empty.
- `[not configured]` — No fields in this category have values.
- `[N configured / M total]` — For providers, shows how many providers have API keys vs. total available.

**REQ-3.1.4:** The last two menu items are fixed:

```
  Run Setup Wizard       (configure everything from scratch)
  Export Config as JSON  (view full merged config)
```

**REQ-3.1.5:** After selecting a category, the user sees a table of all settings in that category with current values and origins (Section 4). An inquirer prompt then offers actions:

```
  ? Select an action:
  > Edit a value
    Edit all (category form)
    Reset a value
    ← Back to categories
```

**REQ-3.1.6:** In non-interactive mode (no TTY), `/settings` without arguments falls back to `/settings list` behavior — printing all categories and values as text.

### 3.2 Drilling Down to Individual Settings

**REQ-3.2.1:** From the category view, "Edit a value" presents a list of the category's settings. Selecting one prompts for a new value with the current value as the default.

**REQ-3.2.2:** "Edit all (category form)" presents an inquirer form with all fields in the category, similar to the per-provider sections of the setup wizard. This reuses the same prompting patterns from `setup.ts`.

---

## 4. Settings Display Format

### 4.1 Value Masking

**REQ-4.1.1:** Fields classified as `secret` (see Section 6) MUST always display masked values using the existing `maskSecret()` function from `config-loader.ts`.

**REQ-4.1.2:** The `get` subcommand for a secret field MUST print:
```
providers.openai.apiKey = sk-...4kQ8
  Source: project config (.seepient/setting.json)
```

**REQ-4.1.3:** The `export` subcommand MUST mask all secret fields. Plaintext export is not supported in v1.

**REQ-4.1.4:** Secret fields are:
- `providers.*.apiKey`
- `image.apiKey`
- `smtp.pass`
- `search.tavilyApiKey`
- `notifications.feishu.webhook`
- `notifications.dingtalk.webhook`
- `notifications.wecom.webhook`

### 4.2 Scope Origin Display

**REQ-4.2.1:** Every displayed setting MUST include its origin:

| Origin | Label | Priority |
|---|---|---|
| Env var | `env: <VAR_NAME>` | Highest |
| Project config | `project config (.seepient/setting.json)` | High |
| Global config | `global config (~/.seepient/setting.json)` | Medium |
| Default | `default` | Lowest |

**REQ-4.2.2:** The origin is resolved by checking sources in priority order:
1. Check if an env var maps to this key (via a static `ENV_VAR_MAP`).
2. Check if the key exists in the local config file.
3. Check if the key exists in the global config file.
4. Otherwise, label it `default`.

**REQ-4.2.3:** The `list` subcommand MUST include an `Origin` column:

```
  Setting                 Value              Origin
  ─────────────────────── ────────────────── ──────────────
  provider                openai-compatible   project config
  providers.openai.model  gpt-4o             default
  smtp.host               smtp.gmail.com     global config
  search.tavilyApiKey     tvl-...x9Kf        env: TAVILY_API_KEY
```

### 4.3 Default Value Indicators

**REQ-4.3.1:** When the effective value matches the hardcoded default, display `(default)` after the value.

**REQ-4.3.2:** The `get` subcommand MUST show the default when it differs from the current value:

```
agent.permissionLevel = strict
  Default: moderate
  Source: env: SEEPIENT_PERMISSION
```

### 4.4 Restart Indicators

**REQ-4.4.1:** Settings that require a REPL restart to take effect MUST be annotated with a restart badge in the `list` output:

```
  provider                openai-compatible   project config
  providers.openai.model  gpt-4o             default  [restart]
```

**REQ-4.4.2:** When a restart-required setting is changed via `set`, the command MUST print:
```
  Updated provider. Restart the REPL for this change to take full effect.
```

**REQ-4.4.3:** The `set` subcommand for hot-apply settings MUST print:
```
  Updated smtp.host. Change takes effect immediately.
```

---

## 5. Edit Interactions

### 5.1 Setting Values by Type

**REQ-5.1.1 — String fields:** `set` writes the raw value. No transformation.

```
/settings set smtp.host smtp.gmail.com
→ Updated smtp.host = smtp.gmail.com
```

**REQ-5.1.2 — Number fields:** `set` validates the input is a valid number. Rejects non-numeric input with:
```
  Error: image.n must be a number. Got: "abc"
```

**REQ-5.1.3 — Boolean fields:** `set` accepts `true`, `false`, `1`, `0` (case-insensitive). Rejects other values:
```
  Error: agent.autoConfirm must be true or false. Got: "yes"
```

**REQ-5.1.4 — Enum fields:** `set` validates against the allowed set. For `agent.permissionLevel`, allowed values are `strict`, `moderate`, `permissive`.

### 5.2 Secret/Sensitive Field Handling

**REQ-5.2.1:** When `set` targets a secret field and the value argument is provided, it is accepted without echoing. The confirmation message shows the masked value:
```
/settings set providers.openai.apiKey sk-abc123...
→ Updated providers.openai.apiKey = sk-...23...
```

**REQ-5.2.2:** When `set` targets a secret field and no value argument is given (or value is `-`), the command MUST prompt using inquirer `type: 'password'` with `mask: '*'`:
```
/settings set smtp.pass
? Enter new value for smtp.pass: ********
→ Updated smtp.pass = *****...***
```

### 5.3 Validation

**REQ-5.3.1:** All `set` operations MUST validate before persisting. The validation rules are defined in a static `SETTINGS_SCHEMA` map that specifies for each key: `type` (string|number|boolean|enum), `secret` (boolean), `enumValues` (string[], optional), `min/max` (number, optional).

**REQ-5.3.2:** Invalid values MUST be rejected with a one-line error and the config file MUST NOT be modified.

### 5.4 Persistence Scope

**REQ-5.4.1:** `set` writes to the same scope that currently owns the key:
- If the key was set by env var, print a warning and write to project config instead: `Note: This key is currently overridden by env var TAVILY_API_KEY. Saving to project config. The env var will take precedence until unset.`
- If the key was set by project config, write to project config.
- If the key was set by global config, write to global config.
- If the key was not set (using default), write to project config if a project config file exists; otherwise global config.

**REQ-5.4.2:** `reset` deletes the key from whichever config file contains it. If the key is set by env var, print: `Cannot reset: this value is set by env var TAVILY_API_KEY. Unset the environment variable to use the default.`

**REQ-5.4.3:** All writes use the existing `writeConfigToPath()` function with `mode: 0o600`.

### 5.5 Immediate vs. Restart Effects

**REQ-5.5.1:** Settings are classified into two effect categories:

| Category | Settings | Effect |
|---|---|---|
| **Hot-apply** | `smtp.*`, `search.*`, `notifications.*`, `image.*`, `agent.autoConfirm`, `agent.permissionLevel` | Immediate — the in-memory `config` object is updated in place. |
| **Restart-required** | `provider`, `providers.*.apiKey`, `providers.*.model`, `providers.*.baseUrl` | Requires REPL restart — the active provider instance and Agent are not re-created at runtime (except via `/models`). |

**REQ-5.5.2:** After a successful `set`, update the in-memory config object (`ctx.config`) for hot-apply settings so subsequent tool calls use the new value within the same session.

---

## 6. View-Only vs. Editable Classification

### 6.1 Editable at Runtime

All settings listed in Section 2.3's mapping table are editable. This covers:
- All provider API keys, models, base URLs
- All image generation settings
- All SMTP settings
- Search API key
- All notification webhook/keyword settings
- Agent permission level and autoConfirm

### 6.2 Read-Only Display Properties

**REQ-6.2.1:** The `list` output includes a "Resolved Active" section that shows runtime-computed values that cannot be directly edited:

```
  ── Runtime State (read-only) ──
  Active Provider: openai-compatible
  Active Model: gpt-4o
  Config File (effective): .seepient/setting.json
  Session Mode: interactive
```

**REQ-6.2.2:** These values are displayed via `get` but reject `set`:
```
/settings set activeProvider anthropic
→ Error: "activeProvider" is a read-only runtime value. Use /models to switch providers.
```

### 6.3 Restart Classification Markers

Every setting entry in the schema MUST include a `restartRequired: boolean` flag. This drives the `[restart]` badge in display output and the post-set message.

---

## 7. Integration Points

### 7.1 Relationship with `/models`

**REQ-7.1.1:** `/settings` handles provider configuration as view/edit operations on the underlying config keys. `/models` remains the primary UX for runtime provider/model switching.

**REQ-7.1.2:** When `/settings set` modifies a provider API key or model for the currently active provider, it MUST NOT attempt to hot-swap the runtime provider instance. Instead, it prints:
```
  Updated providers.anthropic.apiKey. Use /models to reload the active provider,
  or restart the REPL.
```

**REQ-7.1.3:** `/models` continues to call `agent.switchProvider()` for immediate runtime switching. No changes to `/models` behavior.

**REQ-7.1.4:** Both commands share the same `saveConfig()` function and the same in-memory config object, so changes from one are visible to the other.

### 7.2 Setup Wizard Reuse

**REQ-7.2.1:** `/settings wizard` calls the existing `runSetup()` from `setup.ts` with no modification. After the wizard completes, the in-memory config is reloaded:
```typescript
const newConfig = loadMergedConfig();
Object.assign(ctx.config, applyEnvOverrides(newConfig));
```

**REQ-7.2.2:** `/settings edit <category>` uses inquirer forms modeled after the corresponding sections of `setup.ts`. Specifically:
- "Providers & Models" category editor reuses `editProviderConfig()`.
- "Image Generation" category editor reuses the image section prompt structure.
- "Email (SMTP)" category editor reuses the email section prompt structure.
- And so on for search and notifications.

### 7.3 Agent Class Integration

**REQ-7.3.1:** The settings handler receives `ctx.config` (the in-memory `AppConfig` object). For hot-apply settings, `set` updates this object directly:
```typescript
ctx.config.smtpHost = 'smtp.gmail.com';
```

**REQ-7.3.2:** For restart-required settings, the in-memory config is updated AND persisted, but the user is warned that the runtime effect requires restart or `/models`.

**REQ-7.3.3:** The `Agent` class does not need new methods. The settings handler operates on the config object and persistence layer, not on the Agent itself.

### 7.4 Future `/status` Command

**REQ-7.4.1:** The settings infrastructure introduced here (key mapping, origin resolution, value display) SHOULD be exported as reusable utilities so a future `/status` command can call `getSettingOrigin()` and `formatSettingValue()` without duplicating logic.

**REQ-7.4.2:** `/status` is out of scope for v1 but the settings handler's internal functions MUST be exported from a separate module (e.g., `src/adapters/cli/commands/settings-utils.ts`) to support this.

---

## 8. Non-Functional Requirements

### 8.1 Performance

**REQ-8.1.1:** `get` and `set` operations MUST complete in under 100ms (single file read/write of a small JSON file).

**REQ-8.1.2:** `list` for all categories MUST complete in under 200ms.

**REQ-8.1.3:** `export` MUST complete in under 100ms.

**REQ-8.1.4:** Config file reads are always from disk (no caching) to ensure freshness when files are edited externally.

### 8.2 Security

**REQ-8.2.1:** Config files written by `/settings` MUST use `mode: 0o600` (owner read/write only), consistent with the existing `writeConfigToPath()`.

**REQ-8.2.2:** Secret values MUST NOT appear in plaintext in any output, including `list`, `get`, and `export`.

**REQ-8.2.3:** The `set` command for secret fields MUST NOT log the plaintext value to console history.

**REQ-8.2.4:** If the config file has overly permissive permissions (not `0o600`), `/settings list` SHOULD print a one-time warning:
```
  Warning: ~/.seepient/setting.json has permissions 0644. Recommended: 0600.
```

### 8.3 Backward Compatibility

**REQ-8.3.1:** Existing config files with the current `AppConfig` structure MUST load without modification.

**REQ-8.3.2:** The legacy flat format (`config.apiKey`, `config.baseUrl`, `config.model`) MUST continue to work via `migrateLegacyFormat()`.

**REQ-8.3.3:** New settings added in future versions MUST NOT break the `/settings` command. Unknown keys in `get`/`set` produce an error; unknown keys in `list`/`export` are displayed under an "Other" category.

**REQ-8.3.4:** The `/models` command MUST NOT be modified. Its behavior remains identical.

### 8.4 Error Handling

**REQ-8.4.1 — File not found:** If neither global nor project config exists, `list` and `get` show defaults. `set` creates the config file.

**REQ-8.4.2 — Invalid JSON:** If a config file contains malformed JSON, print:
```
  Error: Failed to parse config at ~/.seepient/setting.json. Fix the JSON syntax or run /settings wizard.
```

**REQ-8.4.3 — Permission denied:** If `set` cannot write to the config file:
```
  Error: Permission denied writing to ~/.seepient/setting.json. Check file permissions.
```

**REQ-8.4.4 — Validation failure:** Invalid values are rejected before any file write. The error message specifies the expected type/values.

**REQ-8.4.5 — Inquirer cancellation:** Ctrl+C during any interactive prompt returns to the REPL prompt without side effects. Partially completed forms are not persisted.

---

## 9. Out of Scope (v1)

The following are explicitly excluded from the first version:

1. **Server/SDK config editing.** `/settings` is CLI-only. Server and SDK users continue to use their own config mechanisms.
2. **Config hot-reload for restart-required settings.** Provider switching without restart is handled by `/models` only.
3. **Config diffing.** No comparison between global and project configs (displayed as separate "Source" labels instead).
4. **Config migration for new versions.** No `migrate` subcommand. The existing `migrateLegacyFormat()` continues to handle legacy format auto-migration.
5. **Config schema generation.** No `schema` subcommand to export a JSON schema.
6. **Config validation/doctor.** No `check` or `doctor` subcommand. Validation is per-key on `set` only.
7. **Tab completion for dot-notation keys.** Future enhancement.
8. **Undo/rollback for set operations.** Users can `reset` to revert to defaults or re-edit.
9. **Multiple value types in `set` (JSON objects, arrays).** Only scalar values (string, number, boolean, enum) are supported in v1.
10. **`/status` command.** Planned for v2. The settings utilities are designed for reuse but the command itself is not implemented.

---

## 10. Implementation Notes

### 10.1 File Structure

```
src/adapters/cli/commands/
  settings.ts              — Main handler, subcommand router
  settings-keys.ts         — SETTINGS_MAP, SETTINGS_SCHEMA, ENV_VAR_MAP
  settings-display.ts      — formatSettingTable(), formatSettingValue(), getOrigin()
```

### 10.2 Registration

Add to `buildCommandRegistry()` in `repl.ts`:

```typescript
registry.register('settings', settingsHandler(agent, config, activeProviderType), {
  description: 'View and edit configuration',
  aliases: ['config', 'setting'],
});
```

### 10.3 Key Data Structures

**SETTINGS_MAP** — Bidirectional mapping between dot-notation keys and AppConfig paths:
```typescript
type SettingsMapEntry = {
  dotKey: string;             // e.g., "providers.openai.apiKey"
  configPath: string[];       // e.g., ["models", "openai", "apiKey"]
  category: string;           // e.g., "Providers & Models"
  label: string;              // e.g., "OpenAI API Key"
};
```

**SETTINGS_SCHEMA** — Validation metadata per key:
```typescript
type SettingsSchemaEntry = {
  type: 'string' | 'number' | 'boolean' | 'enum';
  secret: boolean;
  enumValues?: string[];
  min?: number;
  max?: number;
  default?: string | number | boolean;
  restartRequired: boolean;
  envVar?: string;            // e.g., "OPENAI_API_KEY"
};
```

### 10.4 Acceptance Tests

| ID | Test | Expected Result |
|---|---|---|
| AT-01 | `/settings` in TTY mode | Interactive category menu appears |
| AT-02 | `/settings list` | All categories with values displayed |
| AT-03 | `/settings get providers.openai.apiKey` | Masked value + origin shown |
| AT-04 | `/settings set smtp.host smtp.gmail.com` | Value persisted to config file |
| AT-05 | `/settings set providers.openai.apiKey` (no value) | Password prompt appears |
| AT-06 | `/settings reset smtp.host` | Key removed from config file |
| AT-07 | `/settings get unknown.key` | Error: "Unknown setting" |
| AT-08 | `/settings set image.n abc` | Error: "must be a number" |
| AT-09 | `/settings set agent.permissionLevel high` | Error: "must be one of: strict, moderate, permissive" |
| AT-10 | `/settings wizard` | Full setup wizard runs |
| AT-11 | `/settings export` | Full config printed as JSON, secrets masked |
| AT-12 | `/settings` in non-TTY mode | Falls back to list output |
| AT-13 | `set` on env-var-overridden key | Warning about env var precedence |
| AT-14 | `reset` on env-var-overridden key | Error: cannot reset env var |
| AT-15 | Set hot-apply value, then use tool | Tool uses updated value |
| AT-16 | `/models` after `/settings set providers.openai.model` | `/models` shows updated model |
