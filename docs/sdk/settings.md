---
title: Settings API
description: Programmatically read, update, watch, and reset configuration settings using the Seepient SDK settings facade.
---

# Settings API

The Seepient SDK provides a first-class programmatic facade for managing application and project configuration. Import the `settings` singleton from `'seepient'` to read, write, batch-update, watch, and reset settings across global (`~/.seepient/config.json`) and project (`./.seepient/config.json`) scopes.

## Import

```typescript
import { settings, SettingsError } from "seepient";
```

## Quick Example

```typescript
import { settings } from "seepient";

// Read a configuration setting
const theme = settings.get("ui.theme");
console.log(`Current theme: ${theme}`);

// Update a setting (persists to project config by default)
await settings.set("permissions.consentMode", "autonomous");

// Listen for configuration updates
const unsubscribe = settings.onChange((changedKeys) => {
  console.log("Settings changed:", changedKeys);
});

// Later, cleanup listener
unsubscribe();
```

---

## API Reference

### `settings.get(dotKey)`

Reads the active value for a setting using its dot-delimited key. Merges environment variables, local project configuration, global user configuration, and system defaults.

```typescript
function get(dotKey: string): SettingValue
```

- **Parameters:**
  - `dotKey` (`string`): The dot-notated setting path, e.g. `"ui.theme"`, `"permissions.consentMode"`, `"models.default"`.
- **Returns:**
  - `SettingValue`: The resolved value (`string | number | boolean | null | Record<string, unknown>`). Throws `SettingsError` if the key is unknown.

```typescript
const model = settings.get("models.default");
const maxSteps = settings.get("agent.maxSteps");
```

---

### `settings.set(dotKey, value)`

Updates a single configuration setting and persists it.

```typescript
function set(dotKey: string, value: string): Promise<void>
```

- **Parameters:**
  - `dotKey` (`string`): The setting key to update.
  - `value` (`string`): The new stringified value. Values are validated and coerced against the schema definition for that setting.
- **Returns:**
  - `Promise<void>`: Resolves once persisted to disk.

```typescript
await settings.set("permissions.consentMode", "ask-everything");
await settings.set("ui.compactMode", "true");
```

---

### `settings.apply(updates)`

Applies a batch of setting updates atomically. Fires the `onChange` listener once for all changed keys.

```typescript
function apply(updates: Record<string, string>): Promise<void>
```

- **Parameters:**
  - `updates` (`Record<string, string>`): A dictionary of dot-notated keys to their new string values.
- **Returns:**
  - `Promise<void>`

```typescript
await settings.apply({
  "permissions.consentMode": "autonomous",
  "agent.maxSteps": "25",
  "ui.theme": "vesper",
});
```

---

### `settings.list()`

Returns a flat array of all registered configuration settings, their current values, default values, descriptions, and source scope.

```typescript
function list(): SettingEntry[]
```

- **Returns:**
  - `SettingEntry[]`: Array of setting descriptor objects.

```typescript
interface SettingEntry {
  key: string;
  category: string;
  description: string;
  value: SettingValue;
  defaultValue: SettingValue;
  type: "string" | "number" | "boolean" | "enum" | "array" | "object";
  enumChoices?: string[];
  scope: "default" | "global" | "project" | "env";
  isSecret?: boolean;
}
```

```typescript
const entries = settings.list();
for (const entry of entries) {
  console.log(`${entry.key} = ${JSON.stringify(entry.value)} (source: ${entry.scope})`);
}
```

---

### `settings.listByCategory()`

Returns all settings grouped by their category name (`"general"`, `"permissions"`, `"models"`, `"ui"`, etc.).

```typescript
function listByCategory(): Record<string, SettingEntry[]>
```

```typescript
const grouped = settings.listByCategory();
console.log("Permission settings:", grouped["permissions"]);
```

---

### `settings.onChange(callback)`

Registers a listener that is invoked whenever one or more settings are updated via `set()`, `apply()`, or `reset()`.

```typescript
function onChange(callback: (changedKeys: string[]) => void): () => void
```

- **Parameters:**
  - `callback` (`(changedKeys: string[]) => void`): Receives the list of updated keys.
- **Returns:**
  - `() => void`: An unsubscribe function that removes the listener.

```typescript
const unsub = settings.onChange((keys) => {
  if (keys.includes("permissions.consentMode")) {
    console.log("Consent mode was reconfigured!");
  }
});

// Stop listening when done
unsub();
```

---

### `settings.reset(dotKey)`

Removes a customized setting from the project configuration file, reverting it to the global configuration or system default.

```typescript
function reset(dotKey: string): Promise<void>
```

```typescript
await settings.reset("permissions.consentMode");
```

---

### `settings.resetAll()`

Resets all customized settings in the project configuration back to defaults.

```typescript
function resetAll(): Promise<void>
```

```typescript
await settings.resetAll();
```

---

## Error Handling

Invalid keys, ill-typed values, or schema violations throw typed `SettingsError` instances:

```typescript
import { settings, SettingsError } from "seepient";

try {
  await settings.set("permissions.consentMode", "invalid-mode");
} catch (err) {
  if (err instanceof SettingsError) {
    console.error(`Settings error [${err.code}]: ${err.message}`);
    // e.g. [INVALID_VALUE]: "invalid-mode" is not a valid ConsentMode. Allowed: ask-everything, edit-enabled, autonomous.
  }
}
```

### Error Codes

| Code | Description |
|---|---|
| `UNKNOWN_KEY` | The provided dotKey does not exist in the schema. |
| `INVALID_VALUE` | The value failed validation or enum constraint. |
| `READ_ONLY` | The setting cannot be mutated at runtime. |
| `PERSIST_FAILED` | Failed to write updated configuration to the filesystem. |

---

## Related APIs

- [createSeepient()](/sdk/create-seepient) — Uses settings for default permissions and limits
- [Stateless Workers](/sdk/stateless-workers) — Environment variables and worker configuration
- [Types Reference](/sdk/types) — Full TypeScript types
