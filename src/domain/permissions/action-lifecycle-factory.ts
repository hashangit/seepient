/**
 * ActionLifecycle factory — Domain (spec 008, T302/T303 wiring).
 *
 * Constructs a fully-wired ActionLifecycle from the inputs a composition root
 * has at hand: workspace, principal, policy store, approval broker, execution
 * boundary, and audit store. The returned lifecycle is what `runAgentLoop`
 * invokes per tool call when `permissionPipeline: true`.
 *
 * This module is the *only* place that assembles a complete pipeline. It
 * exists so transport composition roots (CLI bootstrap, SDK agent, server
 * core) don't each reinvent it — and so the wiring is testable end-to-end
 * without faking a transport.
 *
 * Domain layer: it consumes Foundations contracts + Domain permission modules
 * + an injected ExecutionBoundary. No UI, no Transport.
 */
import { PolicyEngine, computePolicyDigest } from "./policy-engine.js";
import { ActionLifecycle } from "./action-lifecycle.js";
import { LocalAuditStore } from "./audit-recorder.js";
import { LocalPolicyStore, computeWorkspaceId, GLOBAL_WORKSPACE_ID } from "./policy-store.js";
import { setCovers } from "./capability-store.js";
import { DEFAULT_ANALYZERS } from "./default-analyzers.js";
import { COMM_ANALYZERS } from "./comm-analyzers.js";
import type { ToolAnalyzer } from "./default-analyzers.js";
import type {
  ApprovalBroker,
  Capability,
  CapabilitySet,
  PolicyContext,
} from "../../foundations/contracts/permission-policy.js";
import type {
  ExecutionBoundary,
  ExecutionBackendCapabilities,
} from "../../foundations/contracts/execution-boundary.js";
import type { PolicyStore } from "../../foundations/contracts/execution-brokers.js";
import type { PreparedToolAction } from "../../foundations/contracts/prepared-action.js";
import type { ToolAnalysisContext } from "../../foundations/contracts/custom-tools.js";
import type { AuditStore } from "../../foundations/contracts/execution-brokers.js";
import { InMemoryArtifactStore } from "../../capabilities/execution/in-memory-artifact-store.js";
import * as path from "node:path";
import { PersistedCapabilityLedger } from "./persisted-capability-ledger.js";

/** All analyzers, merged. Tools without an analyzer fall through. */
export const ALL_ANALYZERS: Record<string, ToolAnalyzer> = {
  ...DEFAULT_ANALYZERS,
  ...COMM_ANALYZERS,
};

export interface ActionLifecycleInputs {
  principalId: string;
  runId: string;
  sessionId?: string;
  workspaceRoot: string;
  approvalBroker: ApprovalBroker;
  executionBoundary: ExecutionBoundary;
  modelProviderClass?: string;
  policyStore?: PolicyStore;
  /** Optional: audit store. When absent, defaults to LocalAuditStore. */
  auditStore?: AuditStore;
  /** Optional: audit root directory. When absent, uses ~/.seepient/security/audit.
   *  Tests pass a temp dir; production uses the default. */
  auditRoot?: string;
  /** Optional: artifact store shared between analyzers and executors. When
   *  absent, a new InMemoryArtifactStore is created. The transport root that
   *  calls buildLocalBoundary() should pass the SAME store here so the
   *  analyzer and executor share content. */
  artifacts?: import("../../capabilities/execution/in-memory-artifact-store.js").InMemoryArtifactStore;
  /** Optional: deployment ceiling. Default: deny everything not explicitly granted. */
  deploymentCeiling?: CapabilitySet;
  /** Optional: principal policy. Default: empty (caller has no pre-granted caps). */
  principalPolicy?: CapabilitySet;
  /** Optional: runtime baseline. Default: empty. */
  runtimeBaseline?: CapabilitySet;
  /** Optional: immutable deny rules. Default: []. */
  immutableDenies?: PolicyContext["immutableDenies"];
  /** Optional: active session capabilities baseline. */
  activeCapabilities?: CapabilitySet;
  approvalMode?: "manual" | "balanced" | "never";
  /** Interaction contract — derived from the broker by default. */
  interaction?: PolicyContext["interaction"];
  /**
   * Local approval deadline in ms (spec 011 T033 + settings). Default ten
   * minutes; `permissions.approvalTimeoutMs` overrides it. Only used when
   * `interaction` is not supplied.
   */
  approvalDeadlineMs?: number;
  /** Optional: persisted capability ledger for authority consumption & revocation (T107a). */
  capabilityLedger?: PersistedCapabilityLedger;
  /**
   * Optional: a caller-supplied terminal-event outbox. When provided AND the
   * audit store is a `LocalAuditStore`, the lifecycle uses THIS outbox instead
   * of creating its own. This is how long-lived composition roots (CLI, SDK,
   * HTTP server) share ONE outbox across all per-request lifecycles so their
   * flush timer + recovery operate on the same pending-event set.
   *
   * The outbox MUST be backed by the same `LocalAuditStore` instance passed as
   * `auditStore` (or created by this factory when `auditStore` is omitted); the
   * caller is responsible for that pairing.
   */
  terminalOutbox?: import("./audit-recorder.js").TerminalEventOutbox;
}

/**
 * A wired pipeline + the per-call entry point. The composition root holds one
 * of these for the run and calls `prepareAndRun` once per tool call.
 */
export interface WiredActionLifecycle {
  lifecycle: ActionLifecycle;
  /** The execution boundary — exposed so the agent-loop can setCallContext. */
  boundary: ExecutionBoundary;
  /** The PolicyContext used for every evaluation this run. */
  policyContext: PolicyContext;
  /** Mutable active-capability set; approvals add action-scoped caps here. */
  activeCapabilities: { capabilities: Capability[] };
  /** Analyzer registry. Tool calls without a matching analyzer fall through. */
  analyzers: Record<string, ToolAnalyzer>;
  /** Per-run analysis context (artifacts, workspace snapshot). */
  analysisContext: Omit<ToolAnalysisContext, "toolCallId">;
  /** The backing policy store (for /permissions read/write). */
  policyStore: PolicyStore;
  /** The workspace id the store is keyed by. */
  workspaceId: string;
  /** Terminal-event outbox (when the audit store is LocalAuditStore). Composition
   *  roots call `outbox.flush()` on a timer and check `outbox.isHealthy()`. */
  terminalOutbox?: import("./audit-recorder.js").TerminalEventOutbox;
  /** Persisted capability ledger for action consumption & run/session revocation (T107a). */
  capabilityLedger?: PersistedCapabilityLedger;
  /** The backing audit store, for crash-recovery on startup. */
  auditStore: AuditStore;
}

/**
 * Build a wired ActionLifecycle. The policy store is read ONCE at startup to
 * seed `principalPolicy`; subsequent /permissions approvals take effect on
 * the next run (the spec's "policy is snapshotted for a run" rule).
 */
export async function buildActionLifecycle(
  inputs: ActionLifecycleInputs,
): Promise<WiredActionLifecycle> {
  const workspaceId = computeWorkspaceId(inputs.workspaceRoot);
  const policyStore = inputs.policyStore ?? new LocalPolicyStore();

  // Seed principal policy from the protected store. This is the ONE place the
  // PolicyStore feeds into a PolicyContext — answering Finding #2 from the
  // scrutiny review (approved capabilities now affect the next run).
  // Deployment ceiling: defines what the user MAY approve. Canonicalize workspaceRoot
  // with realpathSync so symlink prefixes (e.g. macOS /var -> /private/var) match.
  let root = inputs.workspaceRoot;
  try {
    const { realpathSync: fs_realpathSync, existsSync: fs_existsSync } = await import("node:fs");
    if (root && fs_existsSync(root)) {
      root = fs_realpathSync(root);
    }
  } catch {
    /* keep raw root */
  }

  const deploymentCeiling = inputs.deploymentCeiling ?? {
    version: 1 as const,
    capabilities: [
      { kind: "read-root", root },
      { kind: "write-root", root },
      { kind: "process" },
      { kind: "model-egress", providerClass: "*", dataClasses: ["normal", "sensitive"] },
    ],
  };

  // When no policy exists yet (fresh install), the principal policy defaults
  // to the deployment ceiling so the operator's ceiling IS the starting maximum authority.
  // Freshness is determined by SNAPSHOT VERSION, not capability count (review
  // P0): a versioned EMPTY policy — e.g. after revoking the final capability —
  // is a deliberate state and must NOT resurrect the ceiling baselines on
  // restart.
  let principalPolicy: CapabilitySet;
  let hasStoredPolicy = false;
  try {
    const snap = await policyStore.read(workspaceId);
    if (snap.version > 0 || snap.policy.capabilities.length > 0) {
      principalPolicy = snap.policy;
      hasStoredPolicy = true;
    } else {
      principalPolicy = inputs.principalPolicy ?? deploymentCeiling;
      hasStoredPolicy = Boolean(inputs.principalPolicy);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // No policy file yet — fresh install; the ceiling is the starting maximum.
      principalPolicy = inputs.principalPolicy ?? deploymentCeiling;
      hasStoredPolicy = Boolean(inputs.principalPolicy);
    } else {
      // P1 review fix (fail closed on corruption): a read error (digest
      // mismatch, permissions, IO) must NOT fall back to the deployment
      // ceiling — that would BROADEN authority on a corrupt store. Deny
      // everything instead; the operator must repair or clear the store.
      principalPolicy = { version: 1 as const, capabilities: [] };
      hasStoredPolicy = true;
    }
  }
  // Global protected policy applies to every workspace (spec 011 persistent
  // choices: "Allow always"): union it into the principal policy so global
  // grants survive restarts and seed the active set. Caps already covered by
  // the workspace policy are not duplicated.
  try {
    const globalSnap = await policyStore.read(GLOBAL_WORKSPACE_ID);
    if (globalSnap.policy.capabilities.length > 0) {
      const union: Capability[] = [...principalPolicy.capabilities];
      for (const cap of globalSnap.policy.capabilities) {
        if (!setCovers(principalPolicy, cap)) union.push(cap);
      }
      principalPolicy = { version: 1 as const, capabilities: union };
      hasStoredPolicy = true;
    }
  } catch {
    /* no global policy yet — fresh install continues below */
  }
  const defaultModelEgressCap: Capability = {
    kind: "model-egress",
    providerClass: "*",
    dataClasses: ["normal", "sensitive"],
  };
  const egressCoveredByCeiling = setCovers(deploymentCeiling, defaultModelEgressCap);
  // Only seed the default model-egress cap for a truly fresh install (no stored
  // policy AND no caller-supplied principalPolicy). Widening an explicitly
  // supplied policy/active set would treat the deployment ceiling as an active
  // grant and violate least privilege — a caller that intentionally omits
  // model-egress must keep it omitted.
  const isFreshInstall = !hasStoredPolicy && !inputs.principalPolicy;

  if (isFreshInstall && egressCoveredByCeiling && !principalPolicy.capabilities.some((c) => c.kind === "model-egress")) {
    principalPolicy = {
      ...principalPolicy,
      capabilities: [...principalPolicy.capabilities, defaultModelEgressCap],
    };
  }

  // Runtime baseline: caller-supplied or pass-through from deploymentCeiling.
  const runtimeBaseline = inputs.runtimeBaseline ?? deploymentCeiling;

  // Active session capabilities:
  // - If caller provided explicit activeCapabilities, use them (no widening).
  // - If a principal policy exists (from policyStore or inputs.principalPolicy), start with those pre-approved capabilities.
  // - Otherwise (fresh install), start with workspace read-root baseline so writes/exec require approval.
  const activeCaps: Capability[] = inputs.activeCapabilities
    ? [...inputs.activeCapabilities.capabilities]
    : hasStoredPolicy
      ? [...principalPolicy.capabilities]
      : egressCoveredByCeiling
        ? [{ kind: "read-root" as const, root }, defaultModelEgressCap]
        : [{ kind: "read-root" as const, root }];

  // Seed the default cap only on a fresh install; an explicit caller-supplied
  // activeCapabilities set is preserved as-is.
  if (isFreshInstall && !inputs.activeCapabilities && egressCoveredByCeiling && !activeCaps.some((c) => c.kind === "model-egress")) {
    activeCaps.push(defaultModelEgressCap);
  }

  const activeCapabilities: CapabilitySet = {
    version: 1 as const,
    capabilities: activeCaps,
  };

  const policyContext: PolicyContext = {
    deploymentCeiling,
    principalPolicy,
    runtimeBaseline,
    activeCapabilities: { version: 1, capabilities: activeCapabilities.capabilities },
    immutableDenies: inputs.immutableDenies ?? [],
    approvalMode: inputs.approvalMode ?? "manual",
    interaction: inputs.interaction ?? {
      mode: inputs.approvalBroker.mode,
      // Spec 011 (T033 + settings): the local approval deadline. Default ten
      // minutes; `permissions.approvalTimeoutMs` overrides it. The request
      // expiry and the inline broker's cutoff both derive from this value.
      deadlineMs: inputs.approvalDeadlineMs ?? 600_000,
    },
    backendCapabilities: inputs.executionBoundary.capabilities,
    // Spec 011 (T008): preserve the stable session identity so PolicyEngine
    // can offer the `session` lifetime on TUI requests.
    sessionId: inputs.sessionId,
    // Spec 011 (persistent choices): the protected-policy workspace identity
    // so the engine can offer `project`/`global` approval choices.
    workspaceId,
  };

  const capabilityLedger = inputs.capabilityLedger ?? new PersistedCapabilityLedger(inputs.auditRoot ? { root: path.join(inputs.auditRoot, "caps") } : undefined);
  await capabilityLedger.load().catch(() => {});

  const policyDigest = computePolicyDigest(policyContext);
  const engine = new PolicyEngine(policyDigest, { ledger: capabilityLedger });

  const auditStore = inputs.auditStore ?? new LocalAuditStore(inputs.auditRoot ? { root: inputs.auditRoot } : undefined);
  const artifacts = inputs.artifacts ?? new InMemoryArtifactStore();

  // Honor a caller-supplied outbox when the audit store is a LocalAuditStore.
  // Long-lived composition roots (CLI/SDK/HTTP) pass ONE shared outbox so their
  // flush timer + recovery operate on the same pending-event set as the
  // per-request lifecycle. When the audit store is not a LocalAuditStore, a
  // caller outbox cannot apply and is ignored.
  let terminalOutbox: import("./audit-recorder.js").TerminalEventOutbox | undefined;
  if (auditStore instanceof LocalAuditStore) {
    terminalOutbox = inputs.terminalOutbox ?? new (await import("./audit-recorder.js")).TerminalEventOutbox(auditStore);
  }

  const lifecycle = new ActionLifecycle({
    policy: engine,
    policyContext,
    broker: inputs.approvalBroker,
    boundary: inputs.executionBoundary,
    audit: auditStore,
    activeCapabilities,
    terminalOutbox,
    capabilityLedger,
    sessionId: inputs.sessionId,
    // Persistent (`project`/`global`) approvals write the protected store
    // through compare-and-set, the same trusted flow /permissions uses.
    policyStore,
    workspaceId,
  });

  return {
    lifecycle,
    boundary: inputs.executionBoundary,
    policyContext,
    activeCapabilities,
    analyzers: ALL_ANALYZERS,
    auditStore,
    terminalOutbox,
    capabilityLedger,
    policyStore,
    analysisContext: {
      principalId: inputs.principalId,
      runId: inputs.runId,
      workspace: {
        workspaceId,
        canonicalRoot: root,
        policyVersion: 0,
        policyDigest,
      },
      artifacts,
      modelProviderClass: inputs.modelProviderClass ?? "*",
    },
    workspaceId,
  };
}

/**
 * Resolve an analyzer for a tool call. Returns the analyzer, or `null` when
 * no analyzer is registered — the caller decides whether to fall back to the
 * legacy handler path or deny.
 */
export function resolveAnalyzer(
  analyzers: Record<string, ToolAnalyzer>,
  toolName: string,
): ToolAnalyzer | null {
  return analyzers[toolName] ?? null;
}

export type { PreparedToolAction, ExecutionBackendCapabilities };
