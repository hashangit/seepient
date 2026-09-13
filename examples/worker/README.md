# Seepient Reference Stateless Worker Example

This example demonstrates how to embed the Seepient SDK in a stateless worker tier (container or microVM) for multi-tenant deployments.

## Architecture

In this pattern:
- **Embedder Control Plane**: Owns authentication, tenant state storage (audits, policies, session history), and user-facing approvals. Issues per-tenant Bearer tokens (`POST /api/auth/token`).
- **Stateless Worker**: Spins up per-tenant or per-task in an isolated container/microVM. Authenticates to the control plane with per-tenant Bearer tokens (`Authorization: Bearer <token>`). Embeds the Seepient SDK with injected store adapters (`AuditStore`, `PolicyStore`, `CapabilityLedger`, `PersistenceBackend`).
- **Approval Relay**: Approval prompts are intercepted by `approvalBroker` and relayed to the embedder control plane.

## Key Features
- **Zero Local Disk Writes**: All persistent state routes to the embedder; ephemeral worker disk is discardable.
- **Multi-Tenant Isolation**: Tenant A cannot reach or affect Tenant B's execution state or credentials; control plane endpoints are strictly scoped by composite keys (`principal:resource`).
- **Fail-Closed Security**: Native OS sandbox and permission pipeline remain enforced inside the worker; unauthenticated control plane requests fail closed with 401.

## Authentication & Scoping (FR-018 / FR-003–FR-005)

All control plane endpoints require Bearer authentication.
- **Tokens must be explicitly issued**: Tokens must be issued by the control plane (`POST /api/auth/token`) and supplied via `controlPlaneToken`. Unknown, unissued, or forged tokens fail closed with `401 Unauthorized` (no auto-adoption).
- **Identity derived exclusively from token**: The control plane derives tenant identity (`authPrincipal`) strictly from the authenticated token lookup. Any `principalId` supplied in request bodies (e.g. `POST /api/sessions`, `POST /api/audit`, `POST /api/policy`) is ignored to prevent principal re-binding.
- **Strict resource scoping**: Stored resources (sessions, policies, audits, capability digests) are composite-keyed by principal (`principal:resource`). Deletions and listings operate strictly within the caller's authenticated scope.
- **Explicit token requirement**: Omission of `controlPlaneToken` when instantiating worker stores or `createWorkerAgent` throws `ControlPlaneTokenRequiredError` (`CONTROL_PLANE_TOKEN_REQUIRED`).

### Issuing a Token and Starting a Worker

```typescript
import { createWorkerAgent } from "./src/worker.js";

// 1. Embedder control plane issues a per-tenant token (requires admin secret)
const tokenRes = await fetch("https://control-plane.internal/api/auth/token", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-admin-key": process.env.CONTROL_PLANE_ADMIN_KEY!,
  },
  body: JSON.stringify({ principalId: "tenant-abc" }),
});
const { token } = await tokenRes.json();

// 2. Launch worker agent with the issued controlPlaneToken
const agent = await createWorkerAgent({
  tenantId: "tenant-abc",
  principalId: "tenant-abc",
  sessionId: "session-1",
  workspaceDir: "/tmp/workspace-tenant-abc",
  runtime,
  controlPlaneUrl: "https://control-plane.internal",
  controlPlaneToken: token,
});
```

## Running the Example Tests

```bash
pnpm vitest run examples/worker/__tests__/worker.test.ts
pnpm vitest run examples/worker/src/__tests__/control-plane.test.ts
```

## Container Image & Sandbox Binaries (Spec 019 Matrix)

When packaging a stateless worker container image (e.g. Docker, gVisor, Firecracker):
- **Native Helper (`fs-commit`)**: The precompiled native helper binary (`native/fs-commit/target/release/seepient-fs-commit` or platform binary) should be baked into the container image or mounted read-only.
- **Linux Sandbox**: The container should provide `bwrap` (Bubblewrap) or `nsjail` in the image PATH if machine execution tools (`execute_shell_command`, etc.) are enabled. Without them, execution tools fail closed with `ISOLATION_UNAVAILABLE`.
- **Stateless Filesystem**: Worker container filesystems can be completely ephemeral (`read-only` root with `tmpfs` mounts); all audit records, session messages, capability records, and policies route to the embedder control plane.

## Injectable Skill Sources & Shadowing (Spec 021-1, QS-S3)

Multi-tenant workers can inject remote skill sources (such as a database or control plane API) via `SkillSource` and compose them alongside filesystem layers using `FsSkillSources`.

### Composing Global and Tenant Sources

```typescript
import { createSeepient, FsSkillSources } from "seepient";
import { DbSkillSource } from "./src/db-skill-source.js";

// Global skills (tenant_id is null) + tenant skills (tenant_id = $1)
const globalSource = new DbSkillSource("https://control-plane.internal", { controlPlaneToken: token });
const tenantSource = new DbSkillSource("https://control-plane.internal", { tenantId, controlPlaneToken: token });

const agent = await createSeepient({
  sources: [
    new FsSkillSources(workspaceDir), // Filesystem layers (bundled + workspace)
    globalSource,                     // Shared organizational skills
    tenantSource,                     // Tenant-specific overrides (shadows global on collision)
  ],
  // ... other injected stores (auditStore, policyStore, capabilityLedger, persist)
});
```

When a skill in `tenantSource` shares the same name as one in `globalSource`, the tenant record wins under last-wins composition semantics, and catalog attribution shows the tenant source label.

One-shot execution via `askSeepient` supports the same `sources` option:

```typescript
import { askSeepient } from "seepient";

const result = await askSeepient("Run tenant report", {
  sources: [globalSource, tenantSource],
  skills: true,
});
```

## Embedding in Production Applications

> **Note on Imports**: This example imports modules via relative paths (`../../../src/transport/sdk/index.js`) so that it compiles and runs directly within the monorepo test configuration without publishing. In your standalone application or container, install the package and import the canonical entry point:
> ```typescript
> import { createSeepient, askSeepient, FsSkillSources } from "seepient";
> ```

