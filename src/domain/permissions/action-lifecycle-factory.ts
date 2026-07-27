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
import { LocalPolicyStore, computeWorkspaceId } from "./policy-store.js";
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
  workspaceRoot: string;
  modelProviderClass: string;
  approvalBroker: ApprovalBroker;
  executionBoundary: ExecutionBoundary;
  /** Optional: protected policy store. When absent, defaults to LocalPolicyStore. */
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
  /** Approval mode (mirrors the legacy `approvalMode`). */
  approvalMode?: "manual" | "balanced" | "never";
  /** Interaction contract — derived from the broker by default. */
  interaction?: PolicyContext["interaction"];
  /** Optional: persisted capability ledger for authority consumption & revocation (T107a). */
  capabilityLedger?: PersistedCapabilityLedger;
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
      { kind: "model-egress", providerClass: inputs.modelProviderClass, dataClasses: ["normal"] },
    ],
  };

  // When no policy exists yet (fresh install), the principal policy defaults
  // to the deployment ceiling so the operator's ceiling IS the starting maximum authority.
  let principalPolicy: CapabilitySet;
  try {
    const snap = await policyStore.read(workspaceId);
    if (snap.policy.capabilities.length > 0) {
      principalPolicy = snap.policy;
    } else {
      principalPolicy = inputs.principalPolicy ?? deploymentCeiling;
    }
  } catch {
    principalPolicy = inputs.principalPolicy ?? deploymentCeiling;
  }

  // Runtime baseline: caller-supplied or pass-through from deploymentCeiling.
  const runtimeBaseline = inputs.runtimeBaseline ?? deploymentCeiling;
  // Active session capabilities start with pre-granted capabilities from a
  // stored principal policy or baseline. Default moderate baseline includes
  // workspace read-root and write-root.
  const activeCapabilities = {
    version: 1 as const,
    capabilities: [...principalPolicy.capabilities],
  };

  const policyContext: PolicyContext = {
    deploymentCeiling,
    principalPolicy,
    runtimeBaseline,
    activeCapabilities: { version: 1, capabilities: activeCapabilities.capabilities },
    immutableDenies: inputs.immutableDenies ?? [],
    approvalMode: inputs.approvalMode ?? "manual",
    workspaceRoot: root,
    interaction: inputs.interaction ?? {
      mode: inputs.approvalBroker.mode,
      deadlineMs: 30_000,
    },
    backendCapabilities: inputs.executionBoundary.capabilities,
  };

  const capabilityLedger = inputs.capabilityLedger ?? new PersistedCapabilityLedger(inputs.auditRoot ? { root: path.join(inputs.auditRoot, "caps") } : undefined);
  await capabilityLedger.load().catch(() => {});

  const policyDigest = computePolicyDigest(policyContext);
  const engine = new PolicyEngine(policyDigest, { ledger: capabilityLedger });

  const auditStore = inputs.auditStore ?? new LocalAuditStore(inputs.auditRoot ? { root: inputs.auditRoot } : undefined);
  const artifacts = inputs.artifacts ?? new InMemoryArtifactStore();

  let terminalOutbox: import("./audit-recorder.js").TerminalEventOutbox | undefined;
  if (auditStore instanceof LocalAuditStore) {
    terminalOutbox = new (await import("./audit-recorder.js")).TerminalEventOutbox(auditStore);
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
      modelProviderClass: inputs.modelProviderClass,
    },
    policyStore,
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
