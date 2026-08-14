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
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

function sandboxCommandPath(pathValue: string | undefined): string | undefined {
  if (!pathValue || process.platform !== "darwin") return pathValue;
  const entries = pathValue.split(delimiter).filter(Boolean);
  const selectedGit = entries
    .map((entry) => join(entry, "git"))
    .find((candidate) => existsSync(candidate));
  const cltDir = "/Library/Developer/CommandLineTools/usr/bin";
  if (
    selectedGit === "/usr/bin/git" &&
    existsSync(join(cltDir, "git")) &&
    !entries.includes(cltDir)
  ) {
    return [cltDir, ...entries].join(delimiter);
  }
  return pathValue;
}

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
    const commandPath = sandboxCommandPath(
      this.parentEnv.PATH ?? process.env.PATH,
    );
    const env = sanitizeEnvironment(this.parentEnv, {
      path: commandPath,
      home: operation.command.cwd,
    });

    const result = await this.sandbox.exec({
      command: operation.command,
      roots: operation.roots,
      env,
      signal: opts.signal,
      onUpdate: (chunk) => {
        const msg = typeof chunk === "string" ? chunk : (chunk as any)?.message;
        if (msg) opts.onUpdate?.({ message: msg });
      },
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

    // A signal-terminated child is a CANCELLED execution — the audit must
    // never record an aborted command as succeeded (review P1).
    if (result.signal) {
      return {
        state: "cancelled",
        error: {
          code: "PROCESS_CANCELLED",
          message: `terminated by ${result.signal}`,
          retryable: false,
        },
        evidence,
      };
    }

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
    const diagnostic = [result.stderr, result.stdout]
      .map((value) => value.trim())
      .filter(Boolean)
      .join("\n")
      // Keep terminal diagnostics readable and bounded. Successful command
      // output already follows the normal model-egress path; failures should
      // not become an unbounded or control-character-bearing error string.
      // Covers C0 controls (incl. CR), DEL, and C1 controls (U+0080–U+009F);
      // tab and newline survive for multiline output.
      .replace(/[\u0000-\u0008\u000b\u000c\u000d\u000e-\u001f\u007f\u0080-\u009f]/g, "�")
      .slice(0, 4_096);
    return {
      state: "failed",
      error: {
        code: "PROCESS_NONZERO_EXIT",
        message: diagnostic
          ? `exit ${result.exitCode}: ${diagnostic}`
          : `exit ${result.exitCode}`,
        retryable: false,
      },
      evidence,
    };
  }
}
