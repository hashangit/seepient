# Seepient Architecture

This file is the implementation boundary for Seepient. Internal feature plans
must use these layers and may not introduce alternate directory taxonomies.

## Dependency direction

```text
UI → Transport → Domain → Capabilities → Vendors
           ↘________________↗
        Foundations
```

Foundations may be imported by every layer and imports from no Seepient layer.
All other dependencies point from left to right. Composition roots may wire
across layers, but contain wiring only.

## Layer responsibilities

| Layer | Path | Responsibility |
|---|---|---|
| UI | `src/ui/` | TUI, REPL, CLI presentation, prompts, status, and rendering |
| Transport | `src/transport/` | Authentication, request validation, adapter configuration, protocol translation, and delegation |
| Domain | `src/domain/` | Agent loop, permission decisions, approval lifecycle, sessions, hooks, middleware, settings, and product policy |
| Capabilities | `src/capabilities/` | Stable implementations for LLMs, tools, skills, execution boundaries, filesystem commits, effect brokers, worker scheduling, gateway, and tokenization |
| Vendors | `src/vendors/` | Third-party SDK wrappers and platform-specific vendor integrations |
| Foundations | `src/foundations/` | Shared types, errors, contracts, schemas, persistence vocabulary, hashline, IDs, and the shared network guard (`network/`: IP classifier, pinned fetch, SSRF-validated fetch) |

## Hard rules

- No layer-skipping or upward imports.
- No service SDK import outside `src/vendors/`.
- Sibling capabilities do not import each other. Shared vocabulary belongs in
  `src/foundations/contracts/`; implementations are injected at a composition
  root.
- `src/foundations/` imports from no other Seepient layer.
- No `utils/` grab-bag.
- Files and folders use kebab-case.
- UI frameworks are confined to `src/ui/`.
- Transport validates and delegates; it does not decide product policy.
- Effectful built-in tools do not perform unbrokered side effects. They declare
  and prepare effects; an injected execution boundary enforces them.

## Permission-system ownership

The permission system follows the same dependency direction:

| Concern | Owner |
|---|---|
| Effect, capability, approval, execution, and audit contracts | `src/foundations/contracts/` |
| Policy intersection, action lifecycle, capability lifetime, self-evolution policy | `src/domain/permissions/` |
| Tool action analysis | `src/capabilities/tools/` |
| Native sandbox, file commit broker, effect broker, worker scheduler/client | `src/capabilities/execution/` |
| Seatbelt/Bubblewrap/platform adapters or third-party wrappers | `src/vendors/` when a vendor SDK or wrapper is involved |
| CLI/SDK/HTTP/WS approval brokers and configuration | `src/transport/` composition roots |
| TUI permission prompt and status | `src/ui/tui/` |

The Domain produces one decision for a prepared action. Transport-specific
approval brokers and deployment-specific execution backends are injected; they
do not create alternate policy paths.

## Composition roots

Sanctioned roots may wire all layers but contain no policy logic:

- CLI: `src/ui/cli/index.ts`, `src/transport/cli/bootstrap.ts`, `agent.ts`
- TUI: `src/ui/tui/index.tsx`, `hooks/use-agent.ts`
- REPL: `src/ui/repl/repl.ts`
- Server: `src/transport/http/index.ts`, `server-core.ts`, `standalone.ts`
- SDK: `src/transport/sdk/index.ts`, `seepient.ts`
- Worker scheduler service: `src/transport/worker-scheduler/standalone.ts`

### Adopted application tree (spec 029)

The Seepients product (`apps/*`, `packages/*` renamed `@seepients/*`,
`infra/sandboxes/supervisor`, `infra/updater`) lives in this workspace alongside
the engine; provenance: `provenance/import-manifest.json`.

- **Build/verify scripts (preserved upstream pipeline)**:
  `turbo run build --filter='@seepients/*'` (applications),
  `turbo run check --filter='@seepients/*'` (per-package tsc);
  engine gates unchanged (`build:core`, `boundary:check`, `pack:verify`,
  `qs:core-chat`).
- **Boundary families**: `scripts/check-package-boundary.mjs` additionally
  enforces `R-1` (renderer-isolation — renderer roots cannot reach Prisma,
  credential stores, raw `node:fs`/net, or the DB/vendor barrels) and
  `L-1`/`L-2` (app-layering — `@seepients/*` imports mirror the §2.2
  responsibility table; the ONE sanctioned engine→app edge is
  `src/transport/app/**` → `@seepients/adapter-kit`). Every family ships a
  planted-probe self-test that flips it RED.
- **Sanctioned application composition roots**: `apps/api` (`@seepients/api`),
  `apps/worker` (`@seepients/worker`),
  `infra/sandboxes/supervisor` (`@seepients/sandbox-supervisor`).
  `infra/updater` is retained dormant (not enabled).
- **Engine→app rule**: engine `src/**` MUST NOT import `@seepients/*` except
  the future adapter at `src/transport/app/**` importing
  `@seepients/adapter-kit` types only.

## Security invariants

- Permission, approval, and enforcement are separate.
- The effective capability is a monotonic intersection; no inner layer may
  expand an outer ceiling.
- The process holding provider credentials is not the process executing
  model-authored shell commands.
- Only the trusted worker scheduler service may access a container-runtime
  socket; control-plane and execution-worker processes may not.
- Active security policy and release authority are outside executor-writable
  roots.
- Seepient may prepare changes to itself, including safety code, but cannot
  activate an authority-expanding change from the same trust domain that
  authored it.
- Headless execution never waits for an unavailable human.
- Every action reaches exactly one terminal audit outcome.
