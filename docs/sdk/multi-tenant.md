---
title: Multi-Tenant Isolation
description: Multi-tenant isolation architecture, fail-closed defaults, store injection, and migration guide.
---

# Multi-Tenant Isolation

The Seepient SDK provides strict multi-tenant isolation guarantees. When running multiple tenants or agents within the same application process (e.g. multi-tenant SaaS backends, stateless worker fleets, serverless environments), Seepient enforces fail-closed boundaries across tools, memory, credentials, and state.

---

## Tenancy Modes

Seepient operates in one of two tenancy modes:

1. **`single` (default)**: Optimized for single-user CLI and developer workflows. Allows ambient filesystem defaults (`~/.seepient`), environment variable credential discovery, and local session files. Created via `createAmbientProviderRuntime()` when unsupplied.
2. **`multi`**: Fail-closed mode for multi-tenant deployments. Disables ambient filesystem access, requires full store and runtime injection, scopes permissions and ledgers by `principalId`, requires an explicit workspace `cwd`, and confines tools strictly to each agent's per-agent registry.

### Declaring Tenancy

You can declare tenancy explicitly with `createSeepient`:

```typescript
import { createSeepient } from "seepient";

const agent = await createSeepient({
  tenancy: "multi",
  principalId: "tenant_corp_123",
  cwd: "/var/workspaces/tenant_corp_123",
  runtime: tenantRuntime,
  auditStore: tenantAuditStore,
  policyStore: tenantPolicyStore,
  capabilityLedger: tenantLedgerStore,
  persist: tenantPersistenceBackend,
});
```

### Typed Entry: `createTenantAgent`

For compile-time guarantee of completeness, use `createTenantAgent`. It enforces that runtime, three stores, workspace directory, and a valid principal are supplied:

```typescript
import { createTenantAgent, createIsolatedProviderRuntime } from "seepient";

const agent = await createTenantAgent({
  principalId: "tenant_corp_123",
  cwd: "/var/workspaces/tenant_corp_123",
  runtime: createIsolatedProviderRuntime({ /* tenant credentials */ }),
  auditStore: tenantAuditStore,
  policyStore: tenantPolicyStore,
  capabilityLedger: tenantLedgerStore,
  persist: tenantPersistenceBackend,
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
| **Isolated Runtime** | `runtime` | Required: isolated `ProviderRuntime` instance (`isIsolated: true`) | `TENANCY_RUNTIME_REQUIRED` |
| **Workspace Root** | `cwd` | Required: explicit tenant workspace directory to prevent cross-tenant disk leaks | `TENANCY_WORKSPACE_REQUIRED` |
| **Audit Store** | `auditStore` | Required: embedder `AuditStore` adapter | `TENANCY_STORE_INCOMPLETE` |
| **Policy Store** | `policyStore` | Required: embedder `PolicyStore` adapter | `TENANCY_STORE_INCOMPLETE` |
| **Capability Ledger** | `capabilityLedger` | Required: embedder `CapabilityLedger` adapter | `TENANCY_STORE_INCOMPLETE` |
| **Session Store** | `persist` | Required for sessionful agents (`sessionId` or persistent sessions) | `TENANCY_STORE_INCOMPLETE` |
| **Stateless One-Shot** | `stateless: true` | Optional: pass when executing sessionless calls (`askSeepient`) without persistence | N/A |
| **Skills Sources** | `sources` | Optional: skill sources list. In `multi` mode, ambient discovery is disabled | N/A |

---

## Guarantees & Verifying Tests

Every multi-tenant security guarantee is pinned by an automated CI regression test:

| Guarantee / Invariant | Enforced Behavior in Multi Mode | Error Code / Outcome | Verifying Test Suite |
|---|---|---|---|
| **Zero Ambient Host Secrets** | Execution brokers never resolve host `process.env` secrets | Throws `CREDENTIAL_REQUIRED` before dispatch | `src/domain/permissions/__tests__/composition-closure/exfil-journey.test.ts` |
| **Zero Host Dotfile / Disk Writes** | Replay ledgers default to in-memory (`InMemoryReplayLedger`); no `$HOME/.seepient` writes | Zero writes under `$HOME/.seepient` and cwd | `src/domain/permissions/__tests__/composition-closure/zero-write-brokered.test.ts` |
| **Principal Traversal & Sentinel Rejection** | Branded slug validation (`/^[a-zA-Z0-9_-]{1,128}$/`); case-insensitive sentinel rejection | Throws `InvalidPrincipalIdError` | `src/domain/permissions/__tests__/composition-closure/identity-validation.test.ts` |
| **Session Isolation & Anti-Squatting** | Server sessions partitioned by composite key `${apiKeyHash}:${sessionId}` | Foreign tenant access returns 404 | `src/transport/__tests__/rest-ws-parity.test.ts` |
| **Isolated Server Default Boot** | `runSeepientServer()` boots with isolated empty runtime; no ambient credentials | Emits notice; zero ambient providers; zero writes under `$HOME/.seepient` and cwd; ambient runtime rejected with `TenancyRuntimeRequiredError` | `src/transport/http/__tests__/isolated-boot.test.ts` |
| **Inverted Constructor Defaults** | No-arg `new ProviderRuntime()` is isolated in-memory by default | Stamped `isIsolated: true`; zero env providers | `src/domain/providers/__tests__/isolated-defaults.test.ts` |
| **Inference Wrapper Fail-Closed** | Raw wrappers throw before vendor client invocation for none-kind / undefined secrets | Throws `CREDENTIAL_REQUIRED`; zero outbound network calls | `src/domain/permissions/__tests__/composition-closure/inference-armed-journey.test.ts` |
| **BaseUrl Egress Verification** | Custom `baseUrl` requires granted `network-destination` capability | Throws permission error; blocks egress | `src/vendors/pi-ai/__tests__/inference-fail-closed.test.ts` |
| **Explicit Workspace Contract** | Both SDK roots require explicit `cwd`; server derives workspace per principal | Throws `TENANCY_WORKSPACE_REQUIRED` on omission | `src/transport/sdk/__tests__/sdk-tenancy.test.ts` |
| **Gateway Default-Off** | Operator ambient gateway is never composed into tenant context by default | Zero gateway tools unless explicit opt-in | `src/transport/http/__tests__/gateway-default-off.test.ts` |
| **Edge Tool Validation** | REST /v1/chat endpoint validates `tools` as `string[]` | 400 Bad Request before dispatch | `src/transport/http/__tests__/tools-edge.test.ts` |
| **Reference Worker Control Plane** | Bearer token authentication required; composite keying `principal:resource` | Unauthenticated returns 401; scoped `list()` | `examples/worker/src/__tests__/control-plane.test.ts` |
| **Profile A Local Preservation** | Local CLI/TUI and bare SDK single-mode workflows continue working with ambient conveniences | Clean execution with host keys and dotfiles | `src/__tests__/profile-a-smoke.test.ts` |

---

## Error Codes and Remediation

### 1. `CREDENTIAL_REQUIRED`
- **Cause**: An execution tool or inference operation in `multi` mode attempted to resolve a secret that was not supplied in the tenant's credentials or injected secret resolver. Seepient never falls back to host environment variables in multi-tenant mode.
- **Remediation**: Inject the required API key or credentials into the tenant's `ProviderRuntime` or supply a `secretResolver` in the broker options.

### 2. `TENANCY_WORKSPACE_REQUIRED`
- **Cause**: An agent initialized in `multi` mode without an explicit `cwd` / workspace root.
- **Remediation**: Provide a dedicated per-tenant workspace directory (e.g. `cwd: "/var/workspaces/" + tenantId`).

### 3. `TENANCY_RUNTIME_REQUIRED`
- **Cause**: An agent initialized in `multi` mode without providing an isolated `runtime` (or using a runtime without `isIsolated: true`). Ambient runtime creation (`createAmbientProviderRuntime()`) is reserved for single-mode CLI roots.
- **Remediation**:
  ```typescript
  import { createIsolatedProviderRuntime } from "seepient";

  const agent = await createSeepient({
    tenancy: "multi",
    cwd: "/var/workspaces/tenant-1",
    runtime: createIsolatedProviderRuntime({ /* credentials */ }),
    // ...
  });
  ```

### 4. `TENANCY_STORE_INCOMPLETE`
- **Cause**: One or more required stores (`auditStore`, `policyStore`, `capabilityLedger`, or `persist` for sessionful agents) were omitted in `multi` mode.
- **Remediation**: Inject all required storage adapters (`auditStore`, `policyStore`, `capabilityLedger`). For sessionful agents running without session persistence, specify `stateless: true` to exempt `persist`.

### 5. `TENANCY_AMBIENT_IO`
- **Cause**: An attempt was made in `multi` mode to read or write ambient operator configuration or local files under `~/.seepient/**` outside an injected store's own path.
- **Remediation**: Multi-tenant agents must use injected storage and memory backends; do not configure agents to rely on host-level operator settings.

### 6. `TOOL_NAME_CONFLICT`
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
import { createSeepient } from "seepient";

const agent = await createSeepient({
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
