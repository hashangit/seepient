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

## Deployment models

### Model A: Serverless and ephemeral (Lambda, Cloudflare Workers)
- Runs inside short-lived execution contexts.
- Uses brokered tools (web search, notifications, email, media) where operations are contained by design.
- Direct machine execution tools fail closed if OS sandbox containment binaries are not present.
- Every state store is injected on initialization.

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
  SessionStore,
  AuditStore,
  PolicyStore,
  CapabilityLedger
} from 'seepient'

const agent = createSeepient({
  // Injected tenant storage adapters
  sessionStore: myDatabaseSessionStore,
  auditStore: myPostgresAuditStore,
  policyStore: myRedisPolicyStore,
  capabilityLedger: myLedgerStore,

  // Tenant configuration
  tenantId: 'tenant_abc123',
  sessionId: 'sess_task_987',

  // Provider configuration
  provider: 'anthropic',
  model: 'claude-3-7-sonnet'
})

const result = await agent.run('Process incoming customer request')
```

::: warning Store injection completeness
Stateless operation requires injecting all four permission and persistence contracts (`sessionStore`, `auditStore`, `policyStore`, and `capabilityLedger`). If any store is omitted, the missing store falls back to writing to `~/.seepient` on the local filesystem.
:::

---

## State classification

| State category | Scope | Storage location | Description |
|---|---|---|---|
| **Settings** | Worker-local | Environment variables | Ephemeral per-worker configuration. |
| **Model catalog** | Worker-local | In-memory cache | Cached catalog entries refreshed on startup. |
| **Sandbox binaries** | Worker-local | Container image | Compiled helper (`fs-commit`) and sandbox (`bwrap`). |
| **Skill definitions** | Worker-local | Read-only image mount | Bundled skill instructions. |
| **Session history** | Tenant-scoped | Injected `SessionStore` | Messages and tool invocations saved in database. |
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

