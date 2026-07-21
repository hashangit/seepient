# Seepient Permission System 008 — Operator Guide

This document describes the spec-008 permission system: what changed, how to
operate it, and how to migrate from the legacy grant model.

## Current status (read this first)

The spec-008 pipeline is **implemented and wired but opt-in**. Two code paths
coexist:

- **Legacy path** (default): the matrix/grant/admit/autoConfirm branches in
  `runAgentLoop`. The six confirmed defects in spec §"Confirmed current
  defects" remain live on this path.
- **Spec-008 path** (opt-in via `wiredPipeline`): the new Domain-owned
  pipeline. When `wiredPipeline` is set on `AgentLoopOptions`, every tool call
  with a registered analyzer routes through PolicyEngine → ApprovalBroker →
  ExecutionBoundary → audit, bypassing the legacy branches entirely. End-to-
  end proof: `src/transport/__tests__/agent-loop-pipeline.e2e.test.ts`.

Tools with a registered analyzer (`write_file`, `read_file`,
`execute_shell_command`, `send_email`, `web_search`, `send_notification`,
`read_website`, `generate_image`) use the new path when the flag is set. Tools
without an analyzer fall through to the legacy path until migrated.

The default is NOT yet flipped to the new path. Operators who want the
security guarantees today must construct a `WiredActionLifecycle` (via
`buildActionLifecycle`) and pass it as `wiredPipeline`.

## What the new pipeline does

When `wiredPipeline` is set, each tool call follows:

```
tool call
  → prepare immutable action (analyzer)
  → intersect policy (PolicyEngine)
  → allow | needs-approval | deny
  → optional approval broker (one round, one reevaluation)
  → capability envelope
  → execution boundary (sole side-effect entry point)
  → one terminal audit outcome
```

On this path there is no `autoConfirm` bypass, no separate `admitTool`, no
post-preflight risk matrix, and no second grant check. `approvalMode` is an
input to the one policy evaluation.

## Effective authority

The effective capability is a **monotonic intersection**:

```
deployment ceiling
  ∩ principal policy
  ∩ runtime baseline
  ∩ predeclared/session capabilities
  ∩ approved request
```

Every term may narrow. No term may expand a term to its left. Client grants,
model arguments, skills, middleware, and approval UI are never independent
sources of authority.

## Surfaces

| Surface | Approval broker | Execution boundary | Missing approval |
|---|---|---|---|
| TUI / interactive CLI | Inline, abortable | Local native boundary | Wait with deadline, then deny |
| SDK in custom UI | Caller-supplied typed broker | Local or caller backend | Typed denial if broker absent |
| Headless SDK | None | Local/caller backend | Immediate typed denial |
| Headless CLI | None | Local native backend | Structured denial; never prompt |
| REST / scheduled server job | None by default | Isolated per-run worker | Denial or resumable `approval_required` |
| Realtime remote UI | Durable remote broker | Isolated worker | Pending survives reconnect; expiry denies |

`--yes` means "never prompt"; it does **not** change the execution boundary.

## `/permissions` command

```
/permissions                              List legacy grants by scope
/permissions status                       Show enforcement + protected policy state
/permissions propose <kind>:<target>      Stage an inert capability proposal
/permissions review                       List pending proposals
/permissions approve <id>                 Activate a proposal (writes protected policy)
/permissions revoke-cap <index>           Revoke an active capability by index
```

Active policy lives at `~/.seepient/security/policies/<workspace-id>.json` —
**outside executor-writable roots**, with private permissions, exclusive lock,
fsync, atomic rename, and compare-and-set versioning. Proposals are inert
until approved through this trusted administrative flow.

## Migration from legacy grants

Existing prefix grants are read but **not silently activated**. Only provably
exact, canonical path grants convert to capabilities. Ambiguous entries are
**quarantined** (inactive) and require explicit re-approval:

| Legacy grant | Outcome |
|---|---|
| `write_file: /proj/a.txt` (exact) | Converted → `commit-file:/proj/a.txt` |
| `write_file: /proj/` (prefix) | Quarantined — re-approve via `/permissions propose` |
| `execute_shell_command: npm test` | Quarantined — shell metacharacters make prefix unsafe |
| `write_file` (tool-level, no pattern) | Quarantined — too broad |

## Custom tools

Three explicit trust models (no silent host authority):

- **`preparedTool({ trust: "analyzer", ... })`** — application JavaScript that
  produces a serializable `PreparedToolAction`. Policy-governed.
- **`brokerConnector({ ... })`** — data-only argument-to-request mapping.
  Preferred for untrusted input.
- **`trustedHostTool({ trust: "host", ... })`** — arbitrary JavaScript with
  ambient host authority. Always audit-labelled. Disabled by default in
  server/multi-tenant roots; only an operator allowlist can enable them.

The legacy `tool({ execute })` factory emits a deprecation warning and **fails
closed** at execution until migrated.

## Server deployment

The reference deployment (`docker-compose.008.yml`) splits the server into:

- **control-plane** — HTTP/WS + LLM clients + policy + durable stores. No
  Docker socket. No model-authored execution.
- **scheduler** — the **only** Docker-socket holder. Launches ephemeral
  immutable-image workers per run/session lease.
- **effect-broker** — the **only** network egress for workers. Typed
  HTTP/external-send operations; validates action-bound worker leases.
- **db** — PostgreSQL transactions for policy, approvals, continuations,
  dispatch idempotency, results, audit, terminal outbox.

Workers reach **only** the effect-broker on `broker-net`. They never receive
provider keys, server API keys, release credentials, or active policy files.

## Self-evolution

Seepient can autonomously create and verify change candidates, but the
**activation boundary** is separate:

- **Candidate** — content-addressed workspace under operator-configured roots.
- **Verification** — required checks run in isolated workers; signed evidence.
- **Classification** — `delegated` / `protected` / `needs-attestation` /
  `disallowed`.
- **Activation** — external supervisor contract. The authoring run cannot
  self-attest a protected change.

Without a configured supervisor, the safe result is a **verified candidate
with a pending external activation request** — never an in-process fallback.

## Capability matrix

Run `/permissions status` or see `src/capabilities/execution/capability-matrix.ts`
for the published enforcement shape per backend × platform. Backends that
cannot enforce a capability report it as unsupported; policy never offers an
unenforceable shape.

## Threat model

- Active security policy and release authority are outside executor-writable
  roots.
- The process holding provider credentials is not the process executing
  model-authored shell commands.
- Every action reaches exactly one terminal audit outcome.
- Headless execution never waits for an unavailable human.
- Raw secret retrieval is not a broker operation.
- Secret-class tool output is an immutable deny for model egress.
