/**
 * Operation-executor registry + backend capability negotiation — Capabilities
 * (spec 008, T201, FR-003/NFR-001).
 *
 * The `LocalExecutionBoundary` dispatches a `PreparedOperation` to a typed
 * executor selected by `operation.kind`. Executors are injected at a
 * composition root; the registry holds no executor logic itself, preserving
 * the sibling-capability rule (tools ↔ execution share contracts only).
 *
 * Unsupported operation kinds fail before approval is offered (policy reads
 * `backendCapabilities.supportedOperationKinds` and denies `backend-
 * unsupported` upfront).
 */
import type { PreparedToolAction } from "../../foundations/contracts/prepared-action.js";
import type { PreparedOperation } from "../../foundations/contracts/prepared-action.js";
import type {
  ExecutionBoundary,
  ExecutionBackendCapabilities,
  ExecutionResult,
  ToolProgress,
} from "../../foundations/contracts/execution-boundary.js";
import type { CapabilityEnvelope } from "../../foundations/contracts/permission-policy.js";
import { UnsupportedBackendError } from "../../foundations/errors.js";

/**
 * Execute one prepared operation kind. Executors are sibling capabilities
 * wired at a composition root; they implement this contract and import only
 * Foundations vocabulary.
 */
export interface OperationExecutor {
  readonly kind: PreparedOperation["kind"];
  execute(
    action: PreparedToolAction,
    envelope: CapabilityEnvelope,
    operation: Extract<PreparedOperation, { kind: PreparedOperation["kind"] }>,
    opts: { signal?: AbortSignal; onUpdate?: (u: ToolProgress) => void },
  ): Promise<ExecutionResult>;
}

/**
 * Registry mapping operation kind → executor. Validates at registration that
 * the executor declares a single kind; at execution, routes by kind.
 */
export class OperationExecutorRegistry {
  private readonly executors = new Map<PreparedOperation["kind"], OperationExecutor>();

  register(executor: OperationExecutor): void {
    if (this.executors.has(executor.kind)) {
      throw new Error(`Executor already registered for kind: ${executor.kind}`);
    }
    this.executors.set(executor.kind, executor);
  }

  /** Which operation kinds does this registry currently support? */
  supportedKinds(): PreparedOperation["kind"][] {
    return Array.from(this.executors.keys());
  }

  has(kind: PreparedOperation["kind"]): boolean {
    return this.executors.has(kind);
  }

  async execute(
    action: PreparedToolAction,
    envelope: CapabilityEnvelope,
    opts: { signal?: AbortSignal; onUpdate?: (u: ToolProgress) => void },
  ): Promise<ExecutionResult> {
    const op = action.operation;
    const executor = this.executors.get(op.kind);
    if (!executor) {
      throw new UnsupportedBackendError({
        operationKind: op.kind,
        actionDigest: action.actionDigest,
      });
    }
    // Typed dispatch — the executor's kind matches `op.kind`.
    return executor.execute(
      action,
      envelope,
      op as never /* Extract<PreparedOperation, {kind: executor.kind}> */,
      opts,
    );
  }
}

/**
 * Advertise the capabilities of a registry-backed boundary. Composition roots
 * pass this to `PolicyEngine` so policy never offers an unsupported shape.
 */
export function registryCapabilities(
  registry: OperationExecutorRegistry,
  backend: ExecutionBackendCapabilities["backend"],
  opts: {
    exactCommit?: boolean;
    hostFilteredEgress?: boolean;
    /**
     * True ONLY when a real containment backend is operational. When
     * uncontained execution is explicitly opted into, this stays false and
     * `uncontainedOptIn` is set instead — policy consults both, and status
     * never advertises isolation that does not exist (P1 review fix).
     */
    environmentIsolation?: boolean;
    uncontainedOptIn?: boolean;
  } = {},
): ExecutionBackendCapabilities {
  return {
    backend,
    capabilityKinds: deriveCapabilityKinds(registry.supportedKinds()),
    exactCommit: opts.exactCommit ?? false,
    hostFilteredEgress: opts.hostFilteredEgress ?? false,
    environmentIsolation: opts.environmentIsolation ?? (backend !== "uncontained"),
    uncontainedOptIn: opts.uncontainedOptIn,
    supportedOperationKinds: registry.supportedKinds(),
  };
}

function deriveCapabilityKinds(
  kinds: PreparedOperation["kind"][],
): import("../../foundations/contracts/permission-policy.js").Capability["kind"][] {
  const out: import("../../foundations/contracts/permission-policy.js").Capability["kind"][] = ["model-egress"];
  if (kinds.includes("read-file")) out.push("read-file", "read-root");
  if (kinds.includes("commit-files")) out.push("commit-file");
  if (kinds.includes("process")) out.push("process", "read-root", "write-root", "read-file", "commit-file");
  if (kinds.includes("broker")) {
    out.push("network-destination", "external-recipient", "secret-ref");
  }
  if (kinds.includes("trusted-host")) {
    out.push("trusted-host", "commit-file", "read-file", "read-root", "process");
  }
  return out;
}

export type { ExecutionBoundary };
