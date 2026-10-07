/**
 * Light execution boundary — Capabilities (spec 027 FR-012).
 *
 * The seepient-core default pipeline's boundary: executes `trusted-host` and
 * `none` operations only, with no sandbox, effect broker, or native helper.
 * Any other operation kind fails closed with a typed denial naming the full
 * `seepient` package — never a mid-conversation module-not-found.
 */
import type {
  ExecutionBoundary,
  ExecutionResult,
  ToolProgress,
} from "../../foundations/contracts/execution-boundary.js";
import {
  getExecutionBoundaryFactory,
  type ExecutionBoundaryBuildOptions,
} from "../../foundations/injection-seams.js";
import type { PreparedToolAction } from "../../foundations/contracts/prepared-action.js";
import type { CapabilityEnvelope } from "../../foundations/contracts/permission-policy.js";
import { UnsupportedBackendError } from "../../foundations/errors.js";
import { OperationExecutorRegistry, registryCapabilities } from "./operation-executor-registry.js";
import { InMemoryArtifactStore } from "./in-memory-artifact-store.js";
import { NoneExecutor, TrustedHostExecutor } from "./host-executors.js";

/**
 * Registry whose unsupported-kind denial names the full package (the base
 * registry's generic message reads like an infrastructure fault).
 */
class LightExecutorRegistry extends OperationExecutorRegistry {
  override async execute(
    action: PreparedToolAction,
    envelope: CapabilityEnvelope,
    opts: { signal?: AbortSignal; onUpdate?: (u: ToolProgress) => void },
  ): Promise<ExecutionResult> {
    try {
      return await super.execute(action, envelope, opts);
    } catch (err) {
      if (err instanceof UnsupportedBackendError) {
        throw new UnsupportedBackendError({
          operationKind: err.operationKind,
          actionDigest: action.actionDigest,
          message:
            `Operation "${err.operationKind ?? "?"}" requires executor machinery that ships with ` +
            `the full "seepient" package (not present in seepient-core). Install "seepient", ` +
            `or use trusted-host tools that execute in your own host code.`,
        });
      }
      throw err;
    }
  }
}

export interface BuildLightBoundaryResult {
  boundary: ExecutionBoundary;
  artifacts: InMemoryArtifactStore;
}

/**
 * Build the light boundary: host-callback + none-op executors only. The
 * advertised backend capabilities honestly report zero isolation and no
 * exact-commit, so policy never offers a capability this boundary can't
 * enforce.
 */
export async function buildLightExecutionBoundary(opts?: {
  artifacts?: InMemoryArtifactStore;
  hostCallbacks?: Map<string, (args: unknown) => Promise<unknown>>;
}): Promise<BuildLightBoundaryResult> {
  const artifacts = opts?.artifacts ?? new InMemoryArtifactStore();
  const registry = new LightExecutorRegistry();
  registry.register(new NoneExecutor());
  registry.register(new TrustedHostExecutor(opts?.hostCallbacks ?? new Map()));

  const boundary = {
    capabilities: registryCapabilities(registry, "local-native", {
      exactCommit: false,
      hostFilteredEgress: false,
      environmentIsolation: false,
    }),
    execute: (
      action: PreparedToolAction,
      envelope: CapabilityEnvelope,
      execOpts: { signal?: AbortSignal; onUpdate?: (update: ToolProgress) => void } = {},
    ): Promise<ExecutionResult> => registry.execute(action, envelope, execOpts),
  } satisfies ExecutionBoundary as ExecutionBoundary;

  return { boundary, artifacts };
}

/**
 * The single boundary-resolution point (review ponytail: this ternary lived
 * copy-pasted at three composition sites). Full package registered → its
 * boundary-carrying pipeline; core → the light boundary.
 */
export async function resolveTurnBoundary(
  opts: ExecutionBoundaryBuildOptions & { hostCallbacks?: Map<string, (args: unknown) => Promise<unknown>> },
): Promise<ExecutionBoundary> {
  const factory = getExecutionBoundaryFactory();
  if (factory) {
    const { boundary } = await factory(opts);
    return boundary;
  }
  const { boundary } = await buildLightExecutionBoundary({
    artifacts: opts.artifacts as InMemoryArtifactStore | undefined,
    hostCallbacks: opts.hostCallbacks,
  });
  return boundary;
}
