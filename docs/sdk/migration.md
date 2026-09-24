---
title: v0.8.0 Migration Guide
description: Breaking changes, architectural updates, and transition snippets for Seepient v0.8.0.
---

# v0.8.0 Migration Guide

Seepient v0.8.0 introduces composition closure and fail-closed isolation for multi-tenant deployments (Spec 022-2). This guide outlines the breaking changes and how to update your application.

---

## 1. Isolated Constructor Defaults

### Summary
In v0.7.x, initializing `new ProviderRuntime()`, `new ProviderConfigStore()`, or `new CompositeCredentialStore()` with zero arguments implicitly synthesized ambient host credentials from `process.env` and disk config files.

In v0.8.0, all no-argument constructors are **isolated in-memory by default** and carry `isIsolated: true`. Ambient resolution is completely removed from default construction.

### Before (v0.7.x)
```typescript no-check
import { ProviderRuntime } from "seepient";

// Implicitly read OPENAI_API_KEY from process.env and ~/.seepient
const runtime = new ProviderRuntime();
```

### After (v0.8.0)
For single-user CLI scripts needing ambient host environment keys, use `createAmbientProviderRuntime()`:
```typescript
import { createAmbientProviderRuntime } from "seepient";

// Explicit ambient operator runtime for single-user scripts
const runtime = createAmbientProviderRuntime();
```

For multi-tenant hosting, use `createIsolatedProviderRuntime()` or default construction with an injected `credentialStore`:
```typescript
import { createIsolatedProviderRuntime, MemoryCredentialStore } from "seepient";

const credentialStore = new MemoryCredentialStore();
await credentialStore.put("openai", {
  kind: "api_key",
  keyValue: "sk-tenant-key",
});
const tenantRuntime = createIsolatedProviderRuntime({ credentialStore });
```

---

## 2. Legacy Default Provider Runtime Export Deletion → `createAmbientProviderRuntime` / Single-Mode Wiring

### Summary
The legacy default provider runtime helper export has been deleted from the SDK exports to eliminate ambient runtime composition hazards.

- In single-user mode (`tenancy: "single"`, the default), `createSeepient()` and `askSeepient()` automatically wire `createAmbientProviderRuntime()` if no runtime is supplied.
- When an ambient runtime is needed explicitly (e.g. in developer CLI tools), call `createAmbientProviderRuntime()`.

### Before (v0.7.x)
```typescript no-check
// Legacy v0.7.x (removed):
// const runtime = get...DefaultRuntime();
const result = await askSeepient("Hello", { runtime });
```

### After (v0.8.0)
```typescript
import { createAmbientProviderRuntime, askSeepient } from "seepient";

// Single-user scripts can omit runtime entirely (automatically uses ambient runtime):
const result = await askSeepient("Hello");

// Or explicitly provide ambient runtime:
const runtime = createAmbientProviderRuntime();
const customResult = await askSeepient("Hello", { runtime });
```

---

## 3. Explicit Workspace Contract (`cwd`) in Multi-Tenant Mode

### Summary
In multi-tenant mode (`tenancy: "multi"` or inferred from injected stores), Seepient now strictly requires an explicit `cwd` / workspace root. Omission throws `TENANCY_WORKSPACE_REQUIRED` at construction to prevent cross-tenant workspace or disk contamination.

### Before (v0.7.x)
```typescript no-check
import { createSeepient } from "seepient";

// In v0.7.x, omitting cwd defaulted to host process.cwd()
const agent = await createSeepient({
  tenancy: "multi",
  principalId: "tenant-1",
  runtime: tenantRuntime,
  auditStore,
  policyStore,
  capabilityLedger,
});
```

### After (v0.8.0)
Provide an explicit per-tenant workspace directory:
```typescript
import { createSeepient } from "seepient";

const agent = await createSeepient({
  tenancy: "multi",
  principalId: "tenant-1",
  cwd: "/var/workspaces/tenant-1",
  runtime: tenantRuntime,
  auditStore,
  policyStore,
  capabilityLedger,
});
```

Or use `createTenantAgent` for compile-time enforcement of all required parameters:
```typescript
import { createTenantAgent } from "seepient";

const agent = await createTenantAgent({
  principalId: "tenant-1",
  cwd: "/var/workspaces/tenant-1",
  runtime: tenantRuntime,
  auditStore,
  policyStore,
  capabilityLedger,
});
```

---

## 4. String-Only `tools` at Chat Edges

### Summary
REST (`POST /v1/chat`) and WebSocket (`chat`) endpoints now strictly validate the `tools` array at ingestion. Each entry must be a valid tool name string (`string[]`). Passing object definitions or non-string entries is rejected immediately with `400 Bad Request` or a typed `VALIDATION_ERROR` frame, preventing model context injection attacks.

### Before (v0.7.x)
```json no-check
{
  "message": "Execute task",
  "tools": [
    { "type": "function", "function": { "name": "custom_tool" } }
  ]
}
```

### After (v0.8.0)
Pass only tool name strings:
```json
{
  "message": "Execute task",
  "tools": ["web_search", "get_current_datetime"]
}
```
Custom tools must be registered on the server per-agent tool registry during composition rather than injected through untrusted client request bodies.

---

## 5. Injected Store Isolation Stamps (`isIsolated: true`)

### Summary
In multi-tenant mode, custom store implementations injected into `createSeepient` or `askSeepient` (`auditStore`, `policyStore`, `capabilityLedger`) must explicitly declare `isIsolated: true`. Stamp-less custom store objects are rejected with `TENANCY_STORE_INCOMPLETE`. Built-in in-memory stores (`InMemoryAuditStore`, `InMemoryPolicyStore`, `InMemoryCapabilityLedger`, `InMemoryReplayLedger`) carry this stamp automatically and can be imported directly from `"seepient"`.

### Before (v0.7.x)
```typescript no-check
const agent = await createSeepient({
  tenancy: "multi",
  principalId: "tenant-1",
  cwd: "/workspaces/t1",
  runtime: tenantRuntime,
  auditStore: myCustomAuditStore, // stamp-less object
  policyStore: myCustomPolicyStore,
  capabilityLedger: myCustomLedger,
});
```

### After (v0.8.0)
```typescript
import {
  InMemoryAuditStore,
  InMemoryPolicyStore,
  InMemoryCapabilityLedger,
  InMemoryReplayLedger,
} from "seepient";

const auditStore = new InMemoryAuditStore();
const policyStore = new InMemoryPolicyStore();
const capabilityLedger = new InMemoryCapabilityLedger();
const replayLedger = new InMemoryReplayLedger();

// Or custom store implementation declaring isIsolated: true explicitly:
const myCustomAuditStore = {
  isIsolated: true,
  // ... store implementation
};
```

---

## 6. Principal ID Requirement and Sentinel Rejection

### Summary
In multi-tenant mode (`tenancy: "multi"` or inferred from injected stores/credentials), `principalId` is strictly required and must match `/^[a-zA-Z0-9_-]{1,128}$/`. Default and sentinel identities (`"sdk-user"`, `"default"`, `"anonymous"`) are rejected case-insensitively with `PrincipalRequiredError` (`PRINCIPAL_REQUIRED`).

### Before (v0.7.x)
```typescript no-check
// In v0.7.x, omitting principalId defaulted to "sdk-user"
const agent = await createSeepient({
  tenancy: "multi",
  cwd: "/workspaces/t1",
  runtime: tenantRuntime,
});
```

### After (v0.8.0)
```typescript
import { createSeepient } from "seepient";

const agent = await createSeepient({
  tenancy: "multi",
  principalId: "tenant_user_123",
  cwd: "/workspaces/tenant_user_123",
  runtime: tenantRuntime,
  auditStore,
  policyStore,
  capabilityLedger,
});
```

---

## 7. Inference Fail-Closed Credentials & Egress

### Summary
In multi-tenant mode, omitting provider credentials throws `CredentialRequiredError` (`CREDENTIAL_REQUIRED`). Inference calls never fall back to ambient host environment variables (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc.) inside vendor libraries. Custom `baseUrl` routing requires an explicit network capability grant (`model-egress` / `network-egress`), preventing Bearer-key exfiltration.

### Before (v0.7.x)
```typescript no-check
// In v0.7.x, omitting credentials fell back to process.env.OPENAI_API_KEY
const agent = await createSeepient({
  tenancy: "multi",
  principalId: "tenant_1",
  cwd: "/workspaces/t1",
});
```

### After (v0.8.0)
```typescript
import {
  createSeepient,
  createIsolatedProviderRuntime,
  MemoryCredentialStore,
  InMemoryAuditStore,
  InMemoryPolicyStore,
  InMemoryCapabilityLedger,
} from "seepient";

const credentialStore = new MemoryCredentialStore();
await credentialStore.put("openai", {
  kind: "api_key",
  keyValue: tenantApiKey,
});

const agent = await createSeepient({
  tenancy: "multi",
  principalId: "tenant_1",
  cwd: "/workspaces/t1",
  runtime: createIsolatedProviderRuntime({ credentialStore }),
  auditStore: new InMemoryAuditStore(),
  policyStore: new InMemoryPolicyStore(),
  capabilityLedger: new InMemoryCapabilityLedger(),
});
```

---

## 8. Isolated Credential Store Refusal of Environment References

### Summary
`MemoryCredentialStore` stamped `isIsolated: true` refuses to resolve ambient `{ kind: "env" }` references. In isolated mode, attempting to lease an env-backed credential throws `CredentialRequiredError` rather than reading host `process.env`. In multi-tenant setups, inject static `{ kind: "api_key", keyValue: ... }` credentials.

### Before (v0.7.x)
```typescript no-check
// In v0.7.x, MemoryCredentialStore resolved env vars from host process.env
const credentialStore = new MemoryCredentialStore();
await credentialStore.put("openai", {
  kind: "env",
  name: "OPENAI_API_KEY",
});
```

### After (v0.8.0)
```typescript
import { MemoryCredentialStore } from "seepient";

// In multi-tenant mode, pass the resolved secret value directly
const credentialStore = new MemoryCredentialStore();
await credentialStore.put("openai", {
  kind: "api_key",
  keyValue: resolvedTenantKey,
});
```

---

## 9. 022-3 Breaking Changes

### Summary
Server sessions are now held **in memory** until a `persist` backend is explicitly injected. Previously, a server booted without a persistence option silently wrote session files to the host filesystem (`~/.seepient/sessions` or the working directory). Now the default backend is in-memory (`MemoryPersistenceBackend`); nothing touches disk unless you supply `persist` or a session directory.

### Migration action
If you relied on sessions surviving a restart without configuring persistence, inject a `persist` backend (or set a session directory) explicitly — in-memory sessions are lost when the process exits.

---

## 10. 022-4 Breaking Changes

### Sentinel unification: `cli-user` → `sdk-user`

The `cli-user` sentinel has been removed. All single-mode principals — CLI and SDK alike — are now stamped `sdk-user`.

**Migration action:** approvals previously granted to `cli-user` are ignored after the upgrade. Re-approve once under the new sentinel; grants recorded after the upgrade carry over unchanged.

### In-workspace symlinks are allowed on reads

Reads are authorized against the canonical **realpath** of the target, not the name it is reached by. Symbolic links that resolve inside your workspace ceiling are now allowed (the earlier blanket refusal is superseded). Links whose realpath escapes the workspace ceiling are denied with `PATH_ESCAPES_WORKSPACE`.

**Migration action:** none for normal use. If you linked out of the workspace to grant access to an external file, copy the file into the workspace instead.

### Hardlinked read targets are refused

Reading a file with more than one name on the filesystem (hardlink, `st_nlink > 1`) is denied with `PATH_HARDLINK_REFUSED`. This closes exfiltration through hardlinks created outside the workspace ceiling.

**Migration action:** read regular files inside the workspace. If a legitimate hardlink workflow exists, ask your operator about the explicit opt-in.

### `global` approval lifetime unavailable in multi-tenant mode

In multi-tenant mode, `global` is no longer offered as an approval lifetime. Requesting it directly fails closed with `GLOBAL_LIFETIME_FORBIDDEN` instead of producing a misleading denial. Use `project` or `session` scope instead.

**Migration action:** tenants that persisted `global` lifetimes should re-issue approvals at `project` or `session` scope.

### Read identity verification (device/inode)

The read plane now records the authorized file's device and inode identity and verifies it when the file is opened for execution. If the file at the path changes between authorization and read, the read is denied with `PATH_IDENTITY_MISMATCH`.

**Migration action:** treat `PATH_IDENTITY_MISMATCH` as a retry signal — the file changed mid-flight; re-read it and retry the operation.
