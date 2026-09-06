# Seepient Reference Stateless Worker Example

This example demonstrates how to embed the Seepient SDK in a stateless worker tier (container or microVM) for multi-tenant deployments.

## Architecture

In this pattern:
- **Embedder Control Plane**: Owns authentication, tenant state storage (audits, policies, session history), and user-facing approvals.
- **Stateless Worker**: Spins up per-tenant or per-task in an isolated container/microVM. Embeds the Seepient SDK with injected store adapters (`AuditStore`, `PolicyStore`, `CapabilityLedger`, `PersistenceBackend`).
- **Approval Relay**: Approval prompts are intercepted by `approveTool` and relayed to the embedder control plane.

## Key Features
- **Zero Local Disk Writes**: All persistent state routes to the embedder; ephemeral worker disk is discardable.
- **Multi-Tenant Isolation**: Tenant A cannot reach or affect Tenant B's execution state or credentials.
- **Fail-Closed Security**: Native OS sandbox and permission pipeline remain enforced inside the worker.

## Running the Example Test

```bash
pnpm vitest run examples/worker/__tests__/worker.test.ts
```

## Container Image & Sandbox Binaries (Spec 019 Matrix)

When packaging a stateless worker container image (e.g. Docker, gVisor, Firecracker):
- **Native Helper (`fs-commit`)**: The precompiled native helper binary (`native/fs-commit/target/release/seepient-fs-commit` or platform binary) should be baked into the container image or mounted read-only.
- **Linux Sandbox**: The container should provide `bwrap` (Bubblewrap) or `nsjail` in the image PATH if machine execution tools (`execute_shell_command`, etc.) are enabled. Without them, execution tools fail closed with `ISOLATION_UNAVAILABLE`.
- **Stateless Filesystem**: Worker container filesystems can be completely ephemeral (`read-only` root with `tmpfs` mounts); all audit records, session messages, capability records, and policies route to the embedder control plane.

## Embedding in Production Applications

> **Note on Imports**: This example imports modules via relative paths (`../../../src/transport/sdk/index.js`) so that it compiles and runs directly within the monorepo test configuration without publishing. In your standalone application or container, install the package and import the canonical entry point:
> ```typescript
> import { createSeepient } from "seepient";
> ```
