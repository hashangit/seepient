# Embedding Seepient in Stateless Workers

This guide explains how multi-tenant platforms, cloud workers (containers, microVMs, serverless functions), and orchestrators embed the Seepient SDK statelessly.

## Overview

Seepient provides complete, fail-closed policy enforcement and sandbox execution. When deployed in multi-tenant environments:
- **Isolation Principle**: Tenant A cannot read, write, or reach Tenant B's data, commands, or credentials through Seepient, short of a host-process or kernel compromise.
- **Stateless Operation**: When tenant state stores are injected, the SDK writes **zero** persistent state to the local worker filesystem.
- **Embedder Storage Sovereignty**: The embedder owns and supplies store adapters for sessions, audit logs, policies, capability consumption, and provider configurations.

> [!NOTE]
> **Embedder SDK Entry Points**: Stateless store injection is supported on `createSeepient`, `generateText`, and `streamText`. To operate statelessly without local disk writes, embedders inject their own store contracts (`auditStore`, `policyStore`, `capabilityLedger`, `runtime`, and `persist`).

---

## Deployment Shapes & Isolation Ladder

### Shape A: Serverless & Lightweight (e.g. Vercel Functions, Cloudflare Workers)
- Runs inside short-lived execution contexts.
- Uses brokered tools (web search, fetch, media, notifications, email, skills) where data operations are contained by construction.
- Machine execution tools fail closed (`ISOLATION_UNAVAILABLE`) if OS sandbox containment binaries are not present.
- Every state store is injected; one-shot requests or session resume patterns are used across requests.

### Shape B: Worker Tier (Container / MicroVM per Tenant)
- Each tenant or task runs inside an isolated container (Docker, gVisor) or microVM (Firecracker).
- The Seepient agent executes inside the worker, with the OS-level sandbox isolating tool executions from the host and ambient network.
- Persistent state routes back to the embedder control plane via injected store adapters.

### Isolation Ladder

| Tier | Isolation Mechanism | Guarantee |
|---|---|---|
| **1. Container** | Docker / OCI container per tenant | Separates host-process sharing; kernel is shared. |
| **2. Syscall Interception** | gVisor / Kata Containers per tenant | Syscall filtering; covers kernel attack surfaces. |
| **3. MicroVM** | Firecracker / Cloud Hypervisor per tenant | Hardware virtualization; kernel compromise is guest-scoped. |

---

## Worker-Local State Inventory (FR-009)

When running in stateless worker mode, state is strictly classified:

| State Kind | Scope | Storage Location | Notes |
|---|---|---|---|
| **Settings** | Worker-local | Env variables / Container image | Ephemeral per-worker configuration. |
| **Model Catalog Cache** | Worker-local | Ephemeral in-memory | Rebuilt on startup / cached ephemerally. |
| **Sandbox & Native Binaries** | Worker-local | Container image / Mount | Native helper (`fs-commit`) and sandbox (`bwrap`). |
| **Skills Definitions** | Worker-local | Read-only image / Mount | Bundled skill definitions. |
| **Session History** | **Tenant-scoped** | Injected `PersistenceBackend` | Stored in embedder's database. |
| **Action Audit Trail** | **Tenant-scoped** | Injected `AuditStore` | Enforces pre-dispatch durability. |
| **Grants & Policies** | **Tenant-scoped** | Injected `PolicyStore` | Optimistic concurrency & history. |
| **Capability Leases** | **Tenant-scoped** | Injected `CapabilityLedger` | Consumption digests & revocations. |
| **Model Credentials** | **Tenant-scoped** | Injected `ProviderRuntime` | Managed via `ProviderConfigStore` & `CredentialStore`. |

> [!IMPORTANT]
> **Rule for Queued Specs (M8 Invariant)**: Any future state class (such as 016 session indexing or 018 per-run injection records) must target injected store contracts or extend the contract set; never write directly to the local filesystem on the SDK path.

> [!WARNING]
> **All-or-Nothing Store Injection**: Stateless operation is all-or-nothing. If you inject some stores (e.g. `auditStore` and `policyStore`) but omit others (e.g. `capabilityLedger`), the SDK emits a warning at construction time and the missing stores quietly fall back to local disk at `~/.seepient`. To guarantee zero local disk writes in multi-tenant environments, inject all three permission stores (`auditStore`, `policyStore`, and `capabilityLedger`), along with `runtime` and `persist`.

---

## State Store Contracts & Obligations

Seepient exports TypeScript interfaces for all tenant state stores:

### 1. `PersistenceBackend` (Session History)
Handles loading and saving conversation messages and session metadata.

```typescript
interface PersistenceBackend {
  readonly __persistenceBackend: true;
  save(id: string, data: SessionData): Promise<void>;
  load(id: string): Promise<SessionData | null>;
  delete(id: string): Promise<void>;
  list(): Promise<string[]>;
}
```
- **Tenant Channel**: Seepient passes `provider`, `model`, and `metadata` on every save for tenant keying.

### 2. `AuditStore` (Security & Action Audits)
Records all policy evaluation and tool execution events.

```typescript
interface AuditStore {
  /** Append an audit event; must guarantee durability before resolving "written". */
  append(
    event: ActionAuditEvent,
    opts: { idempotencyKey: string },
  ): Promise<"written" | "duplicate">;
  /** Retrieve terminal event for a given action ID. */
  getTerminal(actionId: string): Promise<ActionAuditEvent | undefined>;
}
```
- **Durability Obligation**: Returning `"written"` must guarantee the record is flushed to persistent storage before tool effects execute.
- **Idempotency**: Duplicate appends with the same `idempotencyKey` (`<actionId>:<state>`) must return `"duplicate"`, never a second record.
- **Crash Recovery**: Custom stores own their own crash recovery; Seepient skips local NDJSON outbox timers.

### 3. `PolicyStore` (Workspace Grants & Rules)
Persists user and policy grants with optimistic concurrency.

```typescript
interface PolicyStore {
  /** Read the policy snapshot for a workspace. */
  read(workspaceId: string): Promise<PolicySnapshot>;
  /** Atomically compare and update the snapshot with optimistic locking. */
  compareAndSet(
    workspaceId: string,
    expectedVersion: number,
    next: CapabilitySet,
    actor: DecisionAuthority,
    mutation?: { mutationId: string },
  ): Promise<PolicySnapshot>;
}
```

### 4. `CapabilityLedger` (Consumption & Revocations)
Records capability lease consumption and evaluates runtime revocations.

```typescript
interface CapabilityLedger {
  /** Initialize or synchronize ledger state (async startup sync). */
  load(): Promise<void>;
  /** Record capability lease consumption against an action digest. */
  consume(envelopeId: string, actionDigest: string): Promise<boolean>;
  /** Revoke matching capability grants. */
  revoke(filter: RevokeFilter): Promise<void>;
  /** Check if an action digest was already consumed (synchronous in-memory check). */
  isConsumedDigest(actionDigest: string): boolean;
  /** Check if a run has been revoked (synchronous in-memory check). */
  isRunRevoked(runId: string): boolean;
  /** Check if a session has been revoked (synchronous in-memory check). */
  isSessionRevoked(sessionId: string): boolean;
}
```
- **Sync Checking Model**: While `load()`, `consume()`, and `revoke()` are asynchronous for remote synchronization, the gate check methods (`isConsumedDigest`, `isRunRevoked`, and `isSessionRevoked`) are synchronous in-memory checks called hot on every tool invocation. Ensure your implementation hydrates relevant digests during `load()`.

### 5. `ProviderRuntime` (Credentials & Models)
Encapsulates tenant model assignments and credentials without exposing secrets.

```typescript
import { ProviderRuntime, ProviderConfigStore, MemoryCredentialStore } from "seepient";

const runtime = new ProviderRuntime({
  configStore: new ProviderConfigStore(":memory:"),
  credentialStore: new MemoryCredentialStore(),
});
```

---

## Interactive Patterns

### 1. Approval Relay Pattern
For interactive human-in-the-loop approvals:
1. Embedder initializes agent with an `approveTool` callback.
2. When a risky action requires confirmation, `approveTool` blocks and sends the request payload to the embedder's approval API / WebSocket.
3. Once the end-user decides, the embedder resolves the promise with `true` (approved) or `false` (denied).

```typescript
const agent = await createSeepient({
  principalId: "tenant-user-123",
  sessionId: "session-abc",
  cwd: "/workspace",
  runtime,
  auditStore,
  policyStore,
  capabilityLedger,
  persist: persistenceBackend,
  consentMode: "ask-everything",
  approveTool: async (req) => {
    return await embedderClient.requestUserApproval(req);
  },
});
```

### 2. Resume Pattern (Serverless Execution)
For execution that spans multiple requests:
1. Initialize `createSeepient({ sessionId: "sess-123", persist: myBackend })`.
2. Execute `await agent.chat(...)`. Session messages and metadata automatically save to `myBackend`.
3. Release the worker / request context.
4. On subsequent requests with the same `sessionId`, history is restored automatically from `myBackend`.

See [`examples/worker/`](https://github.com/seepient/seepient/tree/main/examples/worker) in the repository for a complete runnable implementation with a stub control plane application.
