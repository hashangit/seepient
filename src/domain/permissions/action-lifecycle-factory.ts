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
}

/**
 * A wired pipeline + the per-call entry point. The composition root holds one
 * of these for the run and calls `prepareAndRun` once per tool call.
 */
export interface WiredActionLifecycle {
  lifecycle: ActionLifecycle;
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
  let principalPolicy = inputs.principalPolicy ?? { version: 1 as const, capabilities: [] };
  try {
    const snap = await policyStore.read(workspaceId);
    if (snap.policy.capabilities.length > 0) {
      principalPolicy = snap.policy;
    }
  } catch {
    // Best effort — fall back to the caller-supplied policy.
  }

  const auditStore = inputs.auditStore ?? new LocalAuditStore();
  const artifacts = new InMemoryArtifactStore();

  const deploymentCeiling = inputs.deploymentCeiling ?? {
    version: 1 as const,
    capabilities: [],
  };
  // Runtime baseline default: do not narrow beyond principal/deployment.
  // An empty set here would intersect to nothing (deny all), which is wrong
  // for the common case where the caller hasn't configured a separate runtime
  // floor. The spec's monotonic chain still holds: principal ∩ deployment is
  // already the effective ceiling, and runtime = principal preserves it.
  const runtimeBaseline = inputs.runtimeBaseline ?? principalPolicy;

  const policyContext: PolicyContext = {
    deploymentCeiling,
    principalPolicy,
    runtimeBaseline,
    // activeCapabilities defaults to the runtime baseline so an empty action-
    // scoped store (no prior approvals) does NOT narrow the intersection to
    // deny-all. The spec's monotonic chain treats each layer as a constraint;
    // an unconstrained action scope = "no additional narrowing beyond runtime."
    activeCapabilities: { version: 1, capabilities: runtimeBaseline.capabilities },
    immutableDenies: inputs.immutableDenies ?? [],
    approvalMode: inputs.approvalMode ?? "manual",
    interaction: inputs.interaction ?? {
      mode: inputs.approvalBroker.mode,
      deadlineMs: 30_000,
    },
    backendCapabilities: inputs.executionBoundary.capabilities,
  };

  const policyDigest = computePolicyDigest(policyContext);
  const engine = new PolicyEngine(policyDigest);
  // The mutable action-scoped store starts at the runtime baseline (same
  // rationale: an empty store must not deny-all). Approvals add caps here.
  const activeCapabilities = { capabilities: [...runtimeBaseline.capabilities] as Capability[] };

  const lifecycle = new ActionLifecycle({
    policy: engine,
    policyContext,
    broker: inputs.approvalBroker,
    boundary: inputs.executionBoundary,
    audit: auditStore,
    activeCapabilities,
  });

  return {
    lifecycle,
    policyContext,
    activeCapabilities,
    analyzers: ALL_ANALYZERS,
    analysisContext: {
      principalId: inputs.principalId,
      runId: inputs.runId,
      workspace: {
        workspaceId,
        canonicalRoot: inputs.workspaceRoot,
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
