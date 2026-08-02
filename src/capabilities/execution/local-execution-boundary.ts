/**
 * LocalExecutionBoundary — Capabilities (spec 008, P2 composition root).
 *
 * Composes the operation-executor registry into an `ExecutionBoundary`. This
 * is the sole side-effect entry point for local execution: a `PreparedAction`
 * arrives with an approved `CapabilityEnvelope`, and the registry dispatches
 * the operation to the matching executor (`commit-files`, `read-file`,
 * `process`, `broker`, or `trusted-host`).
 *
 * Capability negotiation: the boundary advertises
 * `ExecutionBackendCapabilities` so `PolicyEngine` never offers an unsupported
 * shape. The exact-commit and host-filtered-egress flags come from the native
 * helper probe and the effect broker, respectively.
 */
import type { PreparedToolAction } from "../../foundations/contracts/prepared-action.js";
import type {
  ExecutionBoundary,
  ExecutionBackendCapabilities,
  ExecutionResult,
  ToolProgress,
} from "../../foundations/contracts/execution-boundary.js";
import type { CapabilityEnvelope } from "../../foundations/contracts/permission-policy.js";
import { OperationExecutorRegistry } from "./operation-executor-registry.js";
import { registryCapabilities } from "./operation-executor-registry.js";

export interface LocalExecutionBoundaryOptions {
  registry: OperationExecutorRegistry;
  /** Native helper probe result — gates `exactCommit`. */
  exactCommit?: boolean;
  /** Whether the effect broker enforces host-filtered egress. */
  hostFilteredEgress?: boolean;
  /** Honest advertisement of process containment availability. */
  environmentIsolation?: boolean;
  /** Operator opt-in to uncontained process execution (P1 review fix). */
  uncontainedOptIn?: boolean;
}

/**
 * Local execution boundary. Wraps the executor registry and advertises its
 * capability shape. Composition roots register executors (file-commit, process,
 * broker) then construct this boundary.
 */
export class LocalExecutionBoundary implements ExecutionBoundary {
  private readonly registry: OperationExecutorRegistry;
  readonly capabilities: ExecutionBackendCapabilities;

  constructor(opts: LocalExecutionBoundaryOptions) {
    this.registry = opts.registry;
    this.capabilities = registryCapabilities(opts.registry, "local-native", {
      exactCommit: opts.exactCommit ?? false,
      hostFilteredEgress: opts.hostFilteredEgress ?? false,
      environmentIsolation: opts.environmentIsolation,
      uncontainedOptIn: opts.uncontainedOptIn,
    });
  }

  async execute(
    action: PreparedToolAction,
    envelope: CapabilityEnvelope,
    opts: { signal?: AbortSignal; onUpdate?: (update: ToolProgress) => void },
  ): Promise<ExecutionResult> {
    return this.registry.execute(action, envelope, opts);
  }
}
