---
title: Stateless workers
description: Multi-tenant embedder storage, zero-disk operation, and worker deployment patterns.
---

# Stateless workers

This guide explains how multi-tenant platforms, serverless functions, and containerized orchestrators embed the Seepient SDK without writing state to the local worker filesystem.

## Core principles

When deployed in multi-tenant environments:
- **Tenant isolation**: Tenant A cannot read, write, or access Tenant B's data, commands, or credentials through Seepient.
- **Zero local disk writes**: When embedder store adapters are injected, the SDK writes zero persistent state to the local disk.
- **Embedder storage sovereignty**: The host application owns and supplies the database adapters for sessions, audit logs, policies, and credentials.

---

## Slim install for serverless: `seepient-core`

Serverless chat routes that use only the multi-turn engine, the provider system, and injected stores can install **`seepient-core`** instead — the same engine at a ~102 MB clean-install closure (versus ~346 MB), with zero built-in tools, sandbox, MCP gateway, or browser automation in `node_modules`:

```ts
import { createChat } from 'seepient-core'

const chat = await createChat({
  stateless: true,
  // the same injected store trio the full package takes — the contracts are identical
  auditStore, policyStore, capabilityLedger,
  providers,               // record of provider entries, exactly as with `seepient`
  tenancy: 'multi',        // multi-tenant hosting: an isolated runtime + all three stores
  runtime,                 // your isolated ProviderRuntime (required in multi)
  principalId,
  cwd: '/workspace',
})

const res = await chat.send('...')           // one turn
const stream = await chat.stream('...')      // one streaming turn
```

Solo (non-hosted) serverless functions can instead pass `tenancy: 'single'` and skip the store trio — `seepient-core` then defaults to in-memory stores and a light pipeline, so construction and turns write nothing to disk (see [Ambient-free defaults for single+stateless](#ambient-free-defaults-for-singlestateless)).

Behavioral differences are all fail-closed and typed: built-in tool names are rejected at registration naming `seepient`, media/image generation without a registered vendor denies typed, token counting reports `usage.estimateMode: "heuristic"`, and provider model discovery (`refreshModels`) degrades with an actionable message. Tenancy stamping, consent lifecycle, and egress arming are unchanged — the engine-coupled security plane ships in `seepient-core`. Host-executed tools (`trustedHostTool`) run via the light default pipeline. If you need built-in tools, the sandbox, or the MCP gateway, install the full `seepient` package.

---

## Deployment models

### Model A: Serverless and ephemeral (AWS Lambda, Google Cloud Functions, Azure Functions)
- Node-capable function platforms. The engine requires Node ≥ 22 builtins (`node:net`, `node:dns`, `node:child_process`) — edge runtimes without Node builtins (e.g. Cloudflare Workers) cannot run either package.
- Runs inside short-lived execution contexts; every state store is injected on initialization.
- With `seepient-core`, chat turns complete on the light default pipeline with zero ambient-disk writes; with the full package, brokered tools (web search, notifications, email, media) are contained by design and direct machine execution tools fail closed without OS containment binaries.

### Model B: Container worker tier (Docker, microVM per tenant)
- Each tenant task runs inside an isolated container (Docker, gVisor) or microVM (Firecracker).
- The Seepient agent executes inside the worker, with OS-level sandboxing (Bubblewrap) isolating tool executions from the container root.
- Persistent state routes back to the embedder database via injected store contracts.

---

## Injecting storage contracts

To run statelessly, inject custom store implementations when creating the agent:

```typescript
import { createSeepient } from 'seepient'
import type {
  PersistenceBackend,
  AuditStore,
  PolicyStore,
  CapabilityLedger
} from 'seepient'

const agent = await createSeepient({
  // Injected tenant storage adapters
  persist: myDatabaseBackend, // PersistenceBackend
  auditStore: myPostgresAuditStore,
  policyStore: myRedisPolicyStore,
  capabilityLedger: myLedgerStore,

  // Tenant configuration
  principalId: 'tenant_abc123',
  sessionId: 'sess_task_987',

  // Provider configuration
  provider: 'anthropic',
  model: 'claude-sonnet-4-6-20260320',
})

const result = await agent.chat('Process incoming customer request')
console.log(result.text)
```

::: warning Store injection completeness
Stateless operation requires injecting all three permission contracts (`auditStore`, `policyStore`, and `capabilityLedger`) along with `persist`. If 1 or 2 permission stores are injected, the SDK logs a warning (`[seepient] WARNING: Partial state store injection detected...`) and falls back missing stores to writing to `~/.seepient` or `./.seepient` on the local filesystem.

For one-shot execution, `askSeepient()` also accepts `auditStore`, `policyStore`, `capabilityLedger`, `principalId`, and `runtime` to run without disk access. For tenant-partitioned or serverless skills, inject external skill sources via `sources` or pass inline literals; see [Skill Sources](/sdk/skills#skill-sources).
:::

---

## State classification

| State category | Scope | Storage location | Description |
|---|---|---|---|
| **Settings** | Worker-local | Environment variables | Ephemeral per-worker configuration. |
| **Model catalog** | Worker-local | In-memory cache | Cached catalog entries refreshed on startup. |
| **Sandbox binaries** | Worker-local | Container image | Compiled helper (`fs-commit`) and sandbox (`bwrap`). |
| **Skill definitions (bundled)** | Worker-local | Read-only image mount | Bundled skill instructions. |
| **Skill definitions (injected)** | Tenant-scoped | Injected `SkillSource` / DB | Tenant-partitioned skills and inline literals. See [Skill Sources](/sdk/skills#skill-sources). |
| **Generated skills** | Tenant-scoped | Injected `SkillStore` | Persisted through embedder `SkillStore.save()`. |
| **Session history** | Tenant-scoped | Injected `PersistenceBackend` | Messages and tool invocations saved in database. |
| **Audit trail** | Tenant-scoped | Injected `AuditStore` | Tamper-evident execution log entries. |
| **Grants and policies** | Tenant-scoped | Injected `PolicyStore` | Tenant permission rules and consent levels. |
| **Credentials** | Tenant-scoped | Injected `ProviderRuntime` | API keys retrieved from tenant secrets vault. |

---

## Layered network defense

When deploying workers in cloud environments (AWS, GCP, Azure, Kubernetes):

1. **Application-layer controls (Seepient)**:
   - **Socket IP pinning**: All outbound HTTP requests through `safeSsrfFetch` resolve destination hostnames, validate resolved IP addresses against private and link-local ranges, and pin the TCP connection directly to the validated IP using `pinnedFetch`. This prevents time-of-check to time-of-use (TOCTOU) DNS rebinding attacks.
   - **Strict range validation**: Private IPv4 (RFC 1918), link-local (`169.254.169.254`), loopback, documentation/carrier-grade NAT (`192.0.0.0/24`, `198.18.0.0/15`), multicast, and mapped IPv6 ranges are blocked by default.
   - **Redirect bounding**: HTTP redirects are capped at 5 hops, and every intermediate target URL is re-validated and re-pinned.

2. **Infrastructure-layer controls (Embedder)**:
   - **IMDSv2 enforcement**: Configure worker virtual machines or container hosts to enforce IMDSv2 (session token required) with hop limit set to 1 (`--http-put-response-hop-limit 1` in AWS EC2). This ensures containers cannot access instance metadata even if container network namespaces share the host interface.
   - **Egress segmentation**: Restrict worker egress at the VPC security group or network policy level. Workers executing unconstrained user tools should not have network access to internal control plane services, databases, or cloud provider APIs.
   - **Complementary roles**: Application-layer pinning protects against loopback sidecar exploits and DNS rebinding to internal services; network egress segmentation and IMDSv2 protect against unauthorized external routing and infrastructure credential exfiltration.

## Reference Implementation

For a complete working implementation of an embedder-owned stateless worker with tenant isolation, custom storage backends, and scoped approval brokers, see the [`examples/worker`](https://github.com/hashangit/seepient/tree/main/examples/worker) reference example.
