/**
 * Host-side executors — Capabilities (spec 027 split).
 *
 * `TrustedHostExecutor` and `NoneExecutor` are the containment-free executors:
 * they consult the composition root's callback map (or return a pre-computed
 * result) and touch no sandbox, broker, or filesystem machinery. They ship in
 * seepient-core so the light default pipeline can complete trusted-host tool
 * turns; the heavy executors stay in `executors.ts` (full package).
 */
import type { PreparedToolAction } from "../../foundations/contracts/prepared-action.js";
import type { CapabilityEnvelope } from "../../foundations/contracts/permission-policy.js";
import type {
  ExecutionResult,
  ToolProgress,
} from "../../foundations/contracts/execution-boundary.js";
import type { OperationExecutor } from "./operation-executor-registry.js";

/**
 * Trusted-host executor — runs host-registered callbacks and nothing else.
 * Misses fail closed with `HOST_TOOL_NOT_REGISTERED`.
 */
export class TrustedHostExecutor implements OperationExecutor {
  readonly kind = "trusted-host" as const;
  private readonly callbacks: Map<string, (args: unknown) => Promise<unknown>>;

  constructor(callbacks: Map<string, (args: unknown) => Promise<unknown>>) {
    this.callbacks = callbacks;
  }

  async execute(
    action: PreparedToolAction,
    _envelope: CapabilityEnvelope,
    operation: Extract<PreparedToolAction["operation"], { kind: "trusted-host" }>,
    _opts: { signal?: AbortSignal; onUpdate?: (u: ToolProgress) => void },
  ): Promise<ExecutionResult> {
    const cb = this.callbacks.get(operation.registrationId) ?? (operation.toolName ? this.callbacks.get(operation.toolName) : undefined);
    if (!cb) {
      return {
        state: "failed",
        error: {
          code: "HOST_TOOL_NOT_REGISTERED",
          message: `No host callback registered for ${operation.registrationId}`,
          retryable: false,
        },
        evidence: {
          backend: "local-native",
          actionDigest: action.actionDigest,
          executorId: "trusted-host",
          operationKind: "trusted-host",
        },
      };
    }
    try {
      const raw = await cb(operation.args);
      const res = typeof raw === "string" ? { output: raw, success: true, metadata: undefined } : (raw as any);
      return {
        state: "succeeded",
        result: {
          output: typeof res?.output === "string" ? res.output : JSON.stringify(res?.output ?? res ?? ""),
          success: res?.success ?? true,
          metadata: res?.metadata,
        },
        evidence: {
          backend: "local-native",
          actionDigest: action.actionDigest,
          executorId: "trusted-host",
          operationKind: "trusted-host",
        },
      };
    } catch (err) {
      return {
        state: "failed",
        error: {
          code: "HOST_TOOL_FAILED",
          message: err instanceof Error ? err.message : String(err),
          retryable: false,
        },
        evidence: {
          backend: "local-native",
          actionDigest: action.actionDigest,
          executorId: "trusted-host",
          operationKind: "trusted-host",
        },
      };
    }
  }
}

/**
 * None-op executor — for tools with no side effects (e.g. get_current_datetime).
 * Returns the pre-computed result attached to the prepared operation.
 */
export class NoneExecutor implements OperationExecutor {
  readonly kind = "none" as const;

  async execute(
    action: PreparedToolAction,
    _envelope: CapabilityEnvelope,
    operation: Extract<PreparedToolAction["operation"], { kind: "none" }>,
    _opts: { signal?: AbortSignal; onUpdate?: (u: ToolProgress) => void },
  ): Promise<ExecutionResult> {
    return {
      state: "succeeded",
      result: operation.result,
      evidence: {
        backend: "local-native",
        actionDigest: action.actionDigest,
        executorId: "none",
        operationKind: "none",
      },
    };
  }
}
