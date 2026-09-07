---
title: Multi-Tenant Isolation
description: Multi-tenant isolation architecture, fail-closed defaults, store injection, and migration guide.
---

# Multi-Tenant Isolation

The Seepient SDK provides strict multi-tenant isolation guarantees. When running multiple tenants or agents within the same application process (e.g. multi-tenant SaaS backends, stateless worker fleets, serverless environments), Seepient enforces fail-closed boundaries across tools, memory, credentials, and state.

---

## Tenancy Modes

Seepient operates in one of two tenancy modes:

1. **`single` (default)**: Optimized for single-user CLI and developer workflows. Allows ambient filesystem defaults (`~/.seepient`), environment variable credential discovery, and local session files.
2. **`multi`**: Fail-closed mode for multi-tenant deployments. Disables ambient filesystem access, requires full store and runtime injection, scopes permissions and ledgers by `principalId`, and confines tools strictly to each agent's per-agent registry.

### Declaring Tenancy

You can declare tenancy explicitly at the SDK root:

```typescript
import { createSeepient } from "seepient";

const agent = await createSeepient({
  tenancy: "multi",
  principalId: "tenant_corp_123",
  runtime: tenantRuntime,
  auditStore: tenantAuditStore,
  policyStore: tenantPolicyStore,
  capabilityLedger: tenantLedgerStore,
  persist: tenantSessionStore,
});
```

### Automatic Upgrade Signals

If `tenancy` is not explicitly declared, Seepient automatically upgrades to `multi` mode when any tenant isolation signals are detected:
- An explicit non-default `principalId` is set
- Any custom permission store (`auditStore`, `policyStore`, `capabilityLedger`) is injected
- A custom `runtime` or `persist` backend is injected
- Injected skill `sources` are supplied

When an upgrade occurs automatically, Seepient outputs a one-time notice to `stderr`:
```text
[seepient] Notice: Tenancy mode automatically upgraded to "multi" based on injected state. To run in single-user mode explicitly, pass tenancy: "single".
```

---

## Injection Checklist for Multi-Tenant Mode

In `multi` mode, Seepient enforces a strict injection checklist at construction time:

| Dependency | Parameter | Requirement | Error on Omission |
|------------|-----------|-------------|-------------------|
| **Isolated Runtime** | `runtime` | Required: isolated `ProviderRuntime` instance with tenant-scoped credentials | `TENANCY_RUNTIME_REQUIRED` |
| **Audit Store** | `auditStore` | Required: embedder `AuditStore` adapter | `TENANCY_STORE_INCOMPLETE` |
| **Policy Store** | `policyStore` | Required: embedder `PolicyStore` adapter | `TENANCY_STORE_INCOMPLETE` |
| **Capability Ledger** | `capabilityLedger` | Required: embedder `CapabilityLedger` adapter | `TENANCY_STORE_INCOMPLETE` |
| **Session Store** | `persist` | Required for sessionful agents (`sessionId` or persistent sessions) | `TENANCY_STORE_INCOMPLETE` |
| **Stateless One-Shot** | `stateless: true` | Optional: pass when executing sessionless calls (`askSeepient`) without persistence | N/A |
| **Skills Sources** | `sources` | Optional: skill sources list. In `multi` mode, ambient discovery is never run; skills come solely from injected sources | N/A |

---

## Error Codes and Remediation

### 1. `TENANCY_RUNTIME_REQUIRED`
- **Cause**: An agent initialized in `multi` mode (explicitly or inferred) without providing an isolated `runtime`. Ambient runtime creation (`getDefaultProviderRuntime()`) is forbidden in multi-tenant mode.
- **Remediation**:
  ```typescript
  // Pass an explicit ProviderRuntime instance
  const agent = await createSeepient({
    tenancy: "multi",
    runtime: myTenantProviderRuntime,
    // ...
  });
  // Or if running a local single-user script, declare single mode explicitly:
  // tenancy: "single"
  ```

### 2. `TENANCY_STORE_INCOMPLETE`
- **Cause**: One or more required stores (`auditStore`, `policyStore`, `capabilityLedger`, or `persist` for sessionful agents) were omitted in `multi` mode.
- **Remediation**: Inject all required storage adapters (`auditStore`, `policyStore`, `capabilityLedger`). For sessionful agents running without session persistence, specify `stateless: true` to exempt `persist`:
  ```typescript
  const agent = await createSeepient({
    tenancy: "multi",
    runtime,
    auditStore: myAuditStore,
    policyStore: myPolicyStore,
    capabilityLedger: myLedger,
    persist: mySessionStore, // Required if sessionId is set unless stateless: true
  });
  ```

### 3. `TENANCY_AMBIENT_IO`
- **Cause**: An attempt was made in `multi` mode to read or write ambient operator configuration or local files under `~/.seepient/**` outside an injected store's own path.
- **Remediation**: Multi-tenant agents must use injected storage and memory backends; do not configure agents to rely on host-level operator settings.

### 4. `TOOL_NAME_CONFLICT`
- **Cause**: Two tools with the identical name were added to the same agent registry.
- **Remediation**: Ensure that custom tools, MCP gateway tools, and built-in tools within an agent's configuration have distinct names.

---

## Per-Agent Tool Registry and Deleted Globals

In Spec 022, global mutable registries were deleted in favor of per-agent isolation. Tools registered for Tenant A are completely invisible to Tenant B:

```typescript
import { createSeepient, trustedHostTool } from "seepient";

// Tool specific to Tenant A
const tenantATool = trustedHostTool({
  name: "billing_portal",
  description: "Manage tenant billing",
  execute: async () => ({ status: "ok" }),
});

// Agent A receives tenantATool
const agentA = await createSeepient({
  principalId: "tenant_a",
  tools: [tenantATool],
  // ...
});

// Agent B receives only default tools; cannot resolve or execute tenantATool
const agentB = await createSeepient({
  principalId: "tenant_b",
  // ...
});
```

### Migration from Deleted Exports

The following legacy global exports have been removed:
- Legacy global tool registration: **Deleted**. Pass `tools: [tool]` into `createSeepient` or `askSeepient`.
- Legacy global tool execution: **Deleted**. Tool execution is now private to the agent loop and governed execution boundary.
- Connector catalog mutators (`unregisterConnector`, `getRegisteredConnectors`, `resetConnectors`): **Deleted**. Connector registries are now instanced per agent via `createConnectorRegistry()`.

---

## MCP Gateway: Returned-Tools Pattern

Pre-022, `gateway.createGateway` implicitly registered tools into a shared global registry. In Spec 022, `createGateway` returns a `{ gateway, tools }` object:

```typescript
import { gateway, createSeepient } from "seepient";

// Initialize gateway
const mcp = await gateway.createGateway(config, settingsAdapter);

// Pass tools explicitly into the agent
const agent = await createSeepient({
  tools: mcp ? mcp.tools : [],
  // ...
});
```

---

## Principal-Scoped Permission State & Ledger

### Grant Persistence

All grants recorded by `PolicyStore` are stamped with the acting `principalId`:
- In `multi` mode, `policyStore.read({ principalId })` returns only grants matching that principal.
- Stored grants from Tenant A never leak to Tenant B, even when sharing a unified database table.

### `operatorBaseline` Pattern

When platform operators want to provide foundational permissions to all tenants (such as basic read permissions) without mutating individual tenant stores:

```typescript
import { createActionLifecycle } from "seepient";

const lifecycle = createActionLifecycle({
  principalId: "tenant_123",
  policyStore,
  operatorBaseline: {
    capabilities: [
      // Base capabilities available to all tenants without approval prompts
    ],
  },
  // ...
});
```

### CapabilityLedger Scoping

The `CapabilityLedger` contract scopes digest consumption by principal:
```typescript
await capabilityLedger.consume(
  environmentId,
  actionDigest,
  { principalId: "tenant_123" },
);
```
Single-use capabilities consumed by Tenant A do not mark digests as expired for Tenant B.

---

## Credential & Operator Configuration Scoping

### Environment Credentials (M10)

Environment variables (e.g. `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`) are classified as operator-scoped:
- In `single` mode, default runtimes read these variables directly for developer convenience.
- In `multi` mode, Seepient never falls back to ambient environment credentials. Each tenant's model calls are governed strictly by credentials in the injected `ProviderRuntime`.

### `settings()` Single-Mode Classification (FR-015)

The `settings()` SDK export reads and mutates local user settings from `~/.seepient/setting.json`:
- `settings()` is strictly a single-user CLI convenience helper.
- Internal runtime and execution pipelines never consult `settings()` in multi-tenant environments. Multi-tenant applications must pass configuration explicitly through agent constructor options.
