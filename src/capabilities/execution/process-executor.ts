/**
 * Process executor — Capabilities (spec 008, T205/T213).
 *
 * Executes a `process` operation through the injected `NativeProcessSandbox`.
 * The sandbox owns Seatbelt/Bubblewrap profile generation; the executor just
 * hands it the sanitized command + env + roots. When the sandbox reports
 * `isolated:false` (uncontained mode), the audit evidence records that fact
 * so status never falsely claims path/network containment (T213).
 */
import type { PreparedToolAction } from "../../foundations/contracts/prepared-action.js";
import type {
  ExecutionResult,
  ToolProgress,
} from "../../foundations/contracts/execution-boundary.js";
import type { CapabilityEnvelope } from "../../foundations/contracts/permission-policy.js";
import type { OperationExecutor } from "./operation-executor-registry.js";
import type { NativeProcessSandbox } from "../../vendors/sandbox-runtime/index.js";
import { sanitizeEnvironment, isSecurityPath } from "./environment-policy.js";

export class ProcessExecutor implements OperationExecutor {
  readonly kind = "process" as const;
  private readonly sandbox: NativeProcessSandbox;
  private readonly parentEnv: NodeJS.ProcessEnv;
  private readonly unsafeUncontained: boolean;

  constructor(opts: { sandbox: NativeProcessSandbox; parentEnv?: NodeJS.ProcessEnv; unsafeUncontained?: boolean }) {
    this.sandbox = opts.sandbox;
    this.parentEnv = opts.parentEnv ?? process.env;
    this.unsafeUncontained = opts.unsafeUncontained ?? false;
  }
  async execute(
    action: PreparedToolAction,
    envelope: CapabilityEnvelope,
    operation: Extract<PreparedToolAction["operation"], { kind: "process" }>,
    opts: { signal?: AbortSignal; onUpdate?: (u: ToolProgress) => void },
  ): Promise<ExecutionResult> {
    if (isSecurityPath(operation.command.cwd)) {
      return {
        state: "failed",
        error: {
          code: "SECURITY_PATH_DENIED",
          message: `Process execution inside the security directory is prohibited: ${operation.command.cwd}`,
          retryable: false,
        },
        evidence: {
          backend: "local-native",
          actionDigest: action.actionDigest,
          executorId: "process-denied",
          operationKind: "process",
        },
      };
    }
    for (const r of operation.roots) {
      if (isSecurityPath(r.canonicalRoot)) {
        return {
          state: "failed",
          error: {
            code: "SECURITY_PATH_DENIED",
            message: `Process root targeting the security directory is prohibited: ${r.canonicalRoot}`,
            retryable: false,
          },
          evidence: {
            backend: "local-native",
            actionDigest: action.actionDigest,
            executorId: "process-denied",
            operationKind: "process",
          },
        };
      }
    }
    // FR-008 / T207a: Fail closed when process containment is unavailable,
    // unless operator explicitly opted into unsafe uncontained execution.
    if (this.sandbox.probe.backend === "none" && !this.unsafeUncontained) {
      return {
        state: "failed",
        error: {
          code: "ISOLATION_UNAVAILABLE",
          message: "Process containment is unavailable on this host (no Seatbelt or Bubblewrap binary found). Process execution fails closed per FR-008 unless unsafe uncontained execution is explicitly enabled.",
          retryable: false,
        },
        evidence: {
          backend: "local-native",
          actionDigest: action.actionDigest,
          executorId: "process-isolation-unavailable",
          operationKind: "process",
        },
      };
    }
    // Sanitize the environment — no ambient control-plane secrets cross.
    const env = sanitizeEnvironment(this.parentEnv, {
      path: process.env.PATH,
      home: operation.command.cwd,
    });

    const result = await this.sandbox.exec({
      command: operation.command,
      roots: operation.roots,
      env,
      signal: opts.signal,
      onUpdate: (chunk) => opts.onUpdate?.({ message: chunk.message }),
    });

    const evidence = {
      backend: "local-native" as const,
      actionDigest: action.actionDigest,
      executorId: this.sandbox.probe.backend === "none" ? "process-uncontained" : "process-sandboxed",
      operationKind: "process" as const,
      // CRITICAL: never claim containment when the sandbox reports isolated:false.
      // The executorId above records the honest enforcement status.
    };
    void envelope;

    if (result.exitCode === 0) {
      return {
        state: "succeeded",
        result: {
          output: result.stdout + (result.stderr ? `\nStderr: ${result.stderr}` : ""),
          success: true,
        },
        evidence,
      };
    }
    return {
      state: "failed",
      error: {
        code: "PROCESS_NONZERO_EXIT",
        message: `exit ${result.exitCode}`,
        retryable: false,
      },
      evidence,
    };
  }
}
