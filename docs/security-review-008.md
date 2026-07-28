# Seepient Permission System 008 — Security Review Package

**Purpose**: This is the **review package for an independent security reviewer**.
Per spec 008 (FR-020), the authoring trust domain cannot self-attest a security-
kernel or authority-expanding change. This document is therefore **not** a
certification — it is the structured package (threat model, asset map, call
paths, audit checklist) the reviewer uses to perform the independent review.

**Reviewer scope**: actual call paths, the native helper, broker, scheduler,
stores, and deployment manifests. The reviewer signs their own attestation
through the `ActivationSupervisor` contract; this package does not.

---

## 1. Threat model

### Trust domains

| Domain | Members | Authority |
|---|---|---|
| **Active trusted state** | running executable, active security policy, operator ceiling, approval identities, release keys, audit config | mounted read-only to tool executors; never executor-writable |
| **Candidate state** | workspace/branch/image candidates | freely modifiable within execution capabilities |
| **Activation authority** | external supervisor, operator action, separately-trusted release service | verifies + activates candidates; never the authoring run |

The same run that authored a candidate **cannot** directly replace active
trusted state or mint the attestation that activates an authority-expanding
change.

### Assets + enforcement

| Asset | Threat | Enforcement | Code path to audit |
|---|---|---|---|
| Provider API keys (OPENAI/ANTHROPIC/GLM) | Worker exfiltration | `sanitizeEnvironment` strips; `WorkerExecutionBoundary` routes effectful ops to scheduler | `src/capabilities/execution/environment-policy.ts`, `worker-execution-boundary.ts` |
| Server/SMTP/release credentials | Worker reads them from env | `FORBIDDEN_ENV_PREFIXES`; worker env reconstructed, never inherited | `environment-policy.ts` |
| Active security policy | Executor rewrites it to self-escalate | `LocalPolicyStore` at `~/.seepient/security/policies/`, private perms, CAS, digest verification | `src/domain/permissions/policy-store.ts` |
| Filesystem (exact write) | Symlink/TOCTOU escape | `seepient-fs-commit` native helper; fails closed with `EXACT_COMMIT_UNAVAILABLE` unless `allowFallback: true` is explicitly configured | `src/vendors/native-fs-commit/index.ts`, `file-commit-broker.ts` |
| Network egress | Worker bypasses broker for private/metadata ranges | `EffectBroker` DNS resolve + address-range check + DNS-rebinding check; `BrokerLeaseAuthority` action-bound single-use lease | `effect-broker.ts`, `broker-lease-authority.ts` |
| Secrets at the broker | Worker requests raw secret retrieval | `BrokeredEffectRequest` union has no fetch-secret variant — structurally unrepresentable | `foundations/contracts/prepared-action.ts` |
| Model-visible history | Secret-class tool output reaches the provider | `ModelEgressGate` immutable-deny for secret/active-policy/release-key/control-plane-credential | `model-egress-gate.ts` |
| Tenant isolation | Tenant A reads tenant B's workspace | `WorkspaceTenantRegistry` binding check; per-run ephemeral worker container; mount allowlist | `vendors/docker/index.ts::validateDispatch`, `docker-worker-scheduler.ts` |
| Docker socket | Control plane or worker obtains it | Socket mounted ONLY in the scheduler service; `docker-compose.008.yml` | `docker-compose.008.yml` |
| Dispatch forgery | Forged nonce/digest/signature launches a second effectful worker | Single-use nonce, action-digest match, mTLS auth, deep-sorted canonical signing | `docker-worker-scheduler.ts`, `worker-execution-boundary.ts::canonicalDispatch` |
| Self-evolution activation | Authoring run activates its own protected change | `classifyProposal` protected class; `attestationMatches` + `isIndependentAttestation`; supervisor-only activation | `self-evolution-policy.ts`, `self-evolution-runtime.ts` |
| Audit integrity | Failed audit write still allows dispatch | Pre-dispatch `dispatched` event is durability gate; terminal outbox idempotent on `<actionId>:<state>` | `audit-recorder.ts`, `action-lifecycle.ts` |

---

## 2. Call paths the reviewer must trace

### 2.1 Tool call → effect (the full pipeline)

```
adapter.chat()
  → runAgentLoop(options)                            [src/domain/agent-loop.ts]
    → for each provider tool_call:
        if options.actionLifecycle:                  [opt-in flag]
          actionLifecycle.run(action, signal)        [src/domain/permissions/action-lifecycle.ts]
            → PolicyEngine.evaluate(action, ctx)     [policy-engine.ts]
            → if needs-approval: ApprovalBroker      [transport/approval-brokers.ts]
            → ExecutionBoundary.execute(action, env) [THE sole side-effect entry point]
              ↳ LocalExecutionBoundary                [local deployment]
                ↳ OperationExecutorRegistry.execute   → CommitFilesExecutor / ProcessExecutor / BrokerExecutor
              ↳ WorkerExecutionBoundary               [server deployment]
                ↳ WorkerScheduler.dispatch            → ephemeral isolated worker
            → AuditRecorder.append (idempotent)      [audit-recorder.ts]
        else: legacy matrix/grant path               [agent-loop.ts L481-521]
```

**Reviewer question**: Can any path bypass `ExecutionBoundary.execute()` and
still produce a model-visible side effect? Trace every `spawn`, `writeFile`,
`fetch`, and `send` in `src/`.

### 2.2 Capability monotonicity

```
PolicyEngine.evaluate()
  → isDeniedByRule(immutableDenies, effect)          [capability-store.ts]
  → backend.supportedOperationKinds.includes(op.kind)
  → effectiveCapabilities(deployment ∩ principal ∩ runtime ∩ active)
  → requiredCapabilities(action.effects)
  → setCovers(effective, required) for each
```

**Reviewer question**: Can an inner input (request/grant/skill/middleware/
approval) expand an outer ceiling? Property test at
`property-fuzz.test.ts` asserts narrowing; reviewer should attempt to construct
a counter-example.

### 2.3 Exact-file commit (the TOCTOU surface)

```
CommitFilesExecutor.execute()
  → FileCommitBroker.commit()
    → capability check: envelope has commit-file for exact path
    → if !helper.available: throw UnsupportedBackendError (FAIL CLOSED)
    → PackagedCommitHelper.commit()
      → spawn seepient-fs-commit --commit <dest>
      → helper owns validate → write → revalidate → rename
      → wrapper verifies returned digest matches input
```

**Reviewer question**: Is there any JS code path that writes to the destination
without going through the helper? Is the helper binary checksummed before
execution? (Probe `src/vendors/native-fs-commit/index.ts::probeCommitHelper`.)

### 2.4 Network egress

```
BrokerExecutor → EffectBroker.execute()
  → verify BrokerAuthContext (expiry, action-digest, single-use-request-id)
  → capability check: envelope has network-destination for host
  → scheme/host DENIED_HOSTS check
  → network.resolve(host) → reject if any IP in DENIED_IPV4_PATTERNS
  → strip FORBIDDEN_REQUEST_HEADERS
  → network.fetch() → reject if effectiveIp ∉ resolved (DNS rebinding)
  → response size cap
  → store response as artifact; never return raw to worker
```

**Reviewer question**: Is direct `fetch()` from a worker possible? Grep for
`fetch(` in any module a worker can import. The worker image should have no
route to public internet except via the broker.

### 2.5 Self-evolution activation

```
createCandidateWorkspace()                           [self-evolution-runtime.ts]
  → buildProposal() → content-addressed digest
  → submitForActivation():
    → attestationMatches(att, proposal, now)         [self-evolution-policy.ts]
    → isIndependentAttestation(att, proposal)
    → classifyProposal(policy, proposal)             → delegated | protected | needs-attestation | disallowed
    → if protected && !supervisor: verified-pending-activation
    → else: supervisor.submit(proposal, attestation)
```

**Reviewer question**: Can the authoring run forge an attestation that passes
`isIndependentAttestation`? The signature is verified by the external
supervisor, not by this codebase — the structural gate here only checks
`verifierId !== authorRunId && authorityId !== authorRunId`. A real deployment
uses a separately-installed supervisor key.

---

## 3. Audit checklist

The reviewer signs off each item independently.

### Foundations (contracts)
- [ ] Every `PreparedOperation` variant is enforced by exactly one executor kind; no orphan kinds.
- [ ] `PolicyDecision` is a closed discriminated union; no fourth variant exists at runtime.
- [ ] `BrokeredEffectRequest` has no `fetch-secret` / `raw-secret` / `socket` variant.
- [ ] `PermissionDenyReason` is a fixed set; no stringly-typed denials.

### Domain (policy + lifecycle)
- [ ] `PolicyEngine.evaluate` applies immutable denies BEFORE any capability check.
- [ ] Headless (`interaction: "none"`) denies `needs-approval` without calling the broker.
- [ ] `ActionLifecycle.run` writes `dispatched` BEFORE execution; failure denies dispatch.
- [ ] Terminal audit events are idempotent on `<actionId>:<state>`.
- [ ] `PolicyStore.compareAndSet` rejects stale `expectedVersion` (CAS conflict).
- [ ] Legacy grants: ambiguous prefix grants are quarantined, never auto-widened.

### Capabilities (execution)
- [ ] `CommitFilesExecutor` fails closed (`EXACT_COMMIT_UNAVAILABLE`) when native helper is unavailable — JS fallback is opt-in (`allowFallback: true`).
- [ ] `EffectBroker` rejects loopback, private, link-local, reserved, and metadata addresses post-DNS.
- [ ] `EffectBroker` rejects DNS rebinding (effective IP must be in resolved set).
- [ ] `EffectBroker` strips `Authorization`, `Cookie`, `Host`, proxy, forwarding headers.
- [ ] `ModelEgressGate` immutable-denies `secret`, `active-policy`, `release-key`, `approval-credential`, `control-plane-credential`.
- [ ] `ProcessExecutor` passes `sanitizeEnvironment(parentEnv)` to the sandbox; provider keys are absent.
- [ ] `UncontainedSandbox` reports `isolated: false`; evidence executorId records the honest status.
- [ ] Browser tools return `backend-unsupported`; no flag launches control-plane Chromium.

### Vendors (platform adapters)
- [ ] `@anthropic-ai/sandbox-runtime` is imported ONLY by `src/vendors/sandbox-runtime/`.
- [ ] The Docker SDK is imported ONLY by `src/vendors/docker/`.
- [ ] The native commit helper is checksummed before execution; mismatched binary rejected.

### Transport (surfaces)
- [ ] `NoneApprovalBroker` never invokes a callback — headless cannot reach a prompt.
- [ ] `InlineApprovalBroker` composes the caller's AbortSignal with a deadline; timeout denies safely.
- [ ] REST `interaction: "never"` returns denial; `interaction: "resumable"` returns promptly with a continuation.
- [ ] `WorkerExecutionBoundary` delegates every effectful operation; control plane executes nothing model-authored.
- [ ] Host tools (`trustedHostTool`) are disabled by default in server roots; only operator allowlist enables them.

### Deployment (server)
- [ ] `docker-compose.008.yml`: Docker socket mounted ONLY in `scheduler`.
- [ ] Control plane and worker have NO Docker socket.
- [ ] Workers reach ONLY `effect-broker` on `broker-net`.
- [ ] Provider keys mounted ONLY to the control plane.
- [ ] `validateNetworkTopology` passes for the production manifest.
- [ ] `WorkspaceTenantRegistry` is configured; cross-tenant dispatch is rejected.

### Self-evolution
- [ ] Candidate workspace is content-addressed; digest covers every file.
- [ ] `classifyProposal` uses the operator-owned policy; candidate-provided policy is untrusted input.
- [ ] Protected change classes require independent activation authority.
- [ ] Without a configured supervisor, the result is `verified-pending-activation` — never an in-process fallback.
- [ ] `detectProtectedWrites` catches symlink escapes into immutable assets.

---

## 4. Known limitations (reviewer must acknowledge)

1. **In-memory stores are not durable across restarts.** `PendingApprovalStore`,
   `LocalAuditStore`, and `BrokerLeaseAuthority.consumed` are in-memory single-
   instance. The reference deployment substitutes PostgreSQL/Redis with
   transactional CAS; production validation requires that substitution.
2. **The native `seepient-fs-commit` helper is a separate build artifact.** Its
   source must be reviewed independently (Rust). The TS wrapper probes for the
   binary and fails closed when absent.
3. **The `sign()` callbacks in tests use fake signers.** Production wiring
   requires real mTLS-backed signing keys for dispatch signatures and broker
   lease tokens.
4. **Cloud schedulers (Cloud Run / Modal / ECS / Kubernetes / microVM) are
   future adapters.** They implement the same `WorkerScheduler` contract but
   are out of scope for v1.

---

## 5. How to run the security test suite

```bash
# Full suite (836 tests including all security gates)
pnpm test

# Targeted security suites
pnpm vitest run src/domain/permissions/__tests__/server-conformance.test.ts   # QS-4.1-4.8
pnpm vitest run src/capabilities/execution/__tests__/effect-broker.test.ts    # network boundary
pnpm vitest run src/capabilities/execution/__tests__/environment-policy.test.ts # secret isolation
pnpm vitest run src/domain/permissions/__tests__/property-fuzz.test.ts        # monotonicity + adversarial paths
pnpm vitest run src/foundations/contracts/__tests__/architecture-boundaries.test.ts # layer rules

# Architecture-boundary gate (must pass — no upward/sibling-capability imports)
pnpm vitest run src/foundations/contracts/__tests__/architecture-boundaries.test.ts
```

The architecture-boundary gate has caught **three** real violations during
implementation; it is the structural backstop for the layer rules in
`ARCHITECTURE.md`.

---

## 6. Reviewer attestation

When the review is complete, the reviewer signs an `ActivationAttestation`
through the `ActivationSupervisor` contract:

```ts
{
  proposalId: "<this-spec's-proposal-id>",
  candidateArtifactDigest: "<content-addressed digest of this implementation>",
  verifierId: "<reviewer-identity>",   // ≠ authorRunId
  authorityId: "<supervisor-identity>", // ≠ authorRunId
  issuedAt: <now>,
  expiresAt: <now + review-window>,
  signature: "<reviewer's signature>"
}
```

Without this attestation, `submitForActivation` returns
`verified-pending-activation`. The implementation does not provide an in-process
fallback.
