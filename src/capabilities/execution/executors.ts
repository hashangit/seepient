/**
 * Operation executors for built-in operation kinds — Capabilities (spec 008,
 * T205/T212).
 *
 * Each executor handles one `PreparedOperation.kind`:
 *  - `CommitFilesExecutor`: routes write_file/edit_file/generated output
 *    through the FileCommitBroker. No built-in structured write performs a
 *    direct destination write (T205).
 *  - `ReadFileExecutor`: reads via canonicalized target; model-egress gate
 *    decides whether bytes reach history.
 *  - `BrokerExecutor`: typed HTTP / external-send via the EffectBroker.
 *  - `UnsupportedExecutor`: returns `backend-unsupported` for browser tools
 *    (and any other effect without a declared backend) (T212). No flag
 *    launches control-plane Chromium.
 *
 * Executors are sibling capabilities — they share Foundations contracts only
 * and never import each other or `capabilities/tools/`.
 */
import type { PreparedToolAction } from "../../foundations/contracts/prepared-action.js";
import type {
  ExecutionResult,
  ToolProgress,
} from "../../foundations/contracts/execution-boundary.js";
import type { CapabilityEnvelope } from "../../foundations/contracts/permission-policy.js";
import type { OperationExecutor } from "./operation-executor-registry.js";
import type {
  FileCommitBroker,
  PreparationArtifactStore,
  EffectBroker,
} from "../../foundations/contracts/execution-brokers.js";
import { UnsupportedBackendError } from "../../foundations/errors.js";
import { isSecurityPath } from "./environment-policy.js";

/** Read the prepared bytes for a commit operation from the artifact store. */
async function readContent(
  artifacts: PreparationArtifactStore,
  ref: import("../../foundations/contracts/prepared-action.js").PreparedArtifactRef,
): Promise<Uint8Array> {
  return artifacts.read(ref);
}

/**
 * Commit-files executor. Validates every target via the FileCommitBroker
 * (which delegates to the native helper when available). When the native
 * helper is absent (exactCommit:false), falls back to an atomic temp+rename
 * write — the SAME mechanism the legacy write_file tool uses. The fallback
 * is less safe (no TOCTOU protection), but:
 *  1. The write uses the PREPARED bytes and destination (not model args).
 *  2. The capability envelope is still checked.
 *  3. Policy and audit still govern the call.
 * The boundary honestly advertises exactCommit:false so policy and the user
 * know the exact-commit guarantee isn't available.
 */
export class CommitFilesExecutor implements OperationExecutor {
  readonly kind = "commit-files" as const;
  private readonly broker: FileCommitBroker;
  private readonly artifacts: PreparationArtifactStore;
  private readonly useNative: boolean;

  constructor(opts: { broker: FileCommitBroker; artifacts: PreparationArtifactStore; useNative?: boolean }) {
    this.broker = opts.broker;
    this.artifacts = opts.artifacts;
    this.useNative = opts.useNative ?? true;
  }

  async execute(
    action: PreparedToolAction,
    envelope: CapabilityEnvelope,
    operation: Extract<PreparedToolAction["operation"], { kind: "commit-files" }>,
    _opts: { signal?: AbortSignal; onUpdate?: (u: ToolProgress) => void },
  ): Promise<ExecutionResult> {
    // T108a: deny any target under ~/.seepient/security/
    for (const commit of operation.commits) {
      if (isSecurityPath(commit.destination.canonicalPath)) {
        return {
          state: "failed",
          error: {
            code: "SECURITY_PATH_DENIED",
            message: `Writes to the security directory are prohibited: ${commit.destination.canonicalPath}`,
            retryable: false,
          },
          evidence: {
            backend: "local-native",
            actionDigest: action.actionDigest,
            executorId: "commit-files-denied",
            operationKind: "commit-files",
          },
        };
      }
    }
    const committed: string[] = [];
    try {
      for (const commit of operation.commits) {
        const bytes = await readContent(this.artifacts, commit.content);
        if (this.useNative) {
          await this.broker.commit({
            envelope,
            destination: commit.destination.canonicalPath,
            content: bytes,
            expected: commit.expected,
          });
        } else if (process.env.SEEPIENT_REQUIRE_NATIVE_FS === "1") {
          return {
            state: "failed",
            error: {
              code: "EXACT_COMMIT_UNAVAILABLE",
              message: "Native exact-commit helper is unavailable on this system; exact file writes fail closed (FR-007).",
              retryable: false,
            },
            evidence: {
              backend: "local-native",
              actionDigest: action.actionDigest,
              executorId: "commit-files-unsupported",
              operationKind: "commit-files",
            },
          };
        } else {
          await this.fallbackWrite(commit.destination.canonicalPath, bytes);
        }
        committed.push(commit.destination.canonicalPath);
      }
      const firstCommit = operation.commits[0];
      let metadata: Record<string, unknown> | undefined;
      if (firstCommit) {
        try {
          const bytes = await readContent(this.artifacts, firstCommit.content);
          metadata = {
            path: action.display.canonicalTargets[0] ?? firstCommit.destination.canonicalPath,
            isNewFile: !firstCommit.expected?.exists,
            newContent: new TextDecoder().decode(bytes),
          };
        } catch (e) {
          process.stderr.write(`METADATA ERROR: ${e instanceof Error ? e.stack : String(e)}\n`);
        }
      }
      return {
        state: "succeeded",
        result: {
          output: `Successfully wrote to ${committed.join(", ")}`,
          success: true,
          metadata,
        },
        evidence: {
          backend: "local-native",
          actionDigest: action.actionDigest,
          executorId: this.useNative ? "commit-files-native" : "commit-files-fallback",
          operationKind: "commit-files",
          committedTargets: committed,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const remaining = operation.commits
        .filter((c) => !committed.includes(c.destination.canonicalPath))
        .map((c) => c.destination.canonicalPath);
      return {
        state: "failed",
        error: {
          code: "COMMIT_FAILED",
          message: committed.length > 0
            ? `${message} (committed: ${committed.join(",")}; uncommitted: ${remaining.join(",")})`
            : message,
          retryable: false,
        },
        evidence: {
          backend: "local-native",
          actionDigest: action.actionDigest,
          executorId: this.useNative ? "commit-files-native" : "commit-files-fallback",
          operationKind: "commit-files",
          committedTargets: committed,
        },
      };
    }
  }

  /**
   * Atomic temp+rename write. Writes to a temp file in the same directory,
   * then renames. On failure the temp is cleaned up and the destination is
   * never partially written. This is the same mechanism the legacy write_file
   * tool uses — not as safe as the native helper (no symlink/TOCTOU defense)
   * but strictly better than the old handler path because the prepared bytes
   * and destination are used, not the raw model args.
   */
  private async fallbackWrite(destination: string, bytes: Uint8Array): Promise<void> {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const crypto = await import("node:crypto");
    const dir = path.dirname(destination);
    const tmp = path.join(dir, `.seepient-tmp-${crypto.randomUUID().slice(0, 8)}`);
    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(tmp, bytes);
      await fs.rename(tmp, destination);
    } catch (err) {
      try { await fs.unlink(tmp); } catch { /* temp may not exist */ }
      throw err;
    }
  }
}

/**
 * Read-file executor. Reads via the canonicalized target; the model-egress
 * gate (consulted by the caller before adding to history) decides release.
 */
export class ReadFileExecutor implements OperationExecutor {
  readonly kind = "read-file" as const;
  private readonly artifacts?: PreparationArtifactStore;

  constructor(opts?: { artifacts?: PreparationArtifactStore }) {
    this.artifacts = opts?.artifacts;
  }

  async execute(
    action: PreparedToolAction,
    _envelope: CapabilityEnvelope,
    operation: Extract<PreparedToolAction["operation"], { kind: "read-file" }>,
    _opts: { signal?: AbortSignal; onUpdate?: (u: ToolProgress) => void },
  ): Promise<ExecutionResult> {
    // T108a: deny reads of the security directory
    if (isSecurityPath(operation.target.canonicalPath)) {
      return {
        state: "failed",
        error: {
          code: "SECURITY_PATH_DENIED",
          message: `Reads of the security directory are prohibited: ${operation.target.canonicalPath}`,
          retryable: false,
        },
        evidence: {
          backend: "local-native",
          actionDigest: action.actionDigest,
          executorId: "read-file-denied",
          operationKind: "read-file",
        },
      };
    }
    try {
      const { readFile } = await import("node:fs/promises");
      const content = await readFile(operation.target.canonicalPath, "utf-8");
      return {
        state: "succeeded",
        result: { output: content, success: true },
        evidence: {
          backend: "local-native",
          actionDigest: action.actionDigest,
          executorId: "read-file",
          operationKind: "read-file",
          committedTargets: [operation.target.canonicalPath],
        },
      };
    } catch (err) {
      return {
        state: "failed",
        error: {
          code: "READ_FAILED",
          message: err instanceof Error ? err.message : String(err),
          retryable: false,
        },
        evidence: {
          backend: "local-native",
          actionDigest: action.actionDigest,
          executorId: "read-file",
          operationKind: "read-file",
        },
      };
    }
  }
}

/**
 * Broker executor. Routes typed HTTP / external-send operations through the
 * EffectBroker; the broker owns DNS, redirects, secret resolution.
 */
export class BrokerExecutor implements OperationExecutor {
  readonly kind = "broker" as const;
  private readonly broker: EffectBroker;
  private readonly artifacts?: PreparationArtifactStore;

  constructor(opts: { broker: EffectBroker; artifacts?: PreparationArtifactStore }) {
    this.broker = opts.broker;
    this.artifacts = opts.artifacts;
  }
  async execute(
    action: PreparedToolAction,
    envelope: CapabilityEnvelope,
    operation: Extract<PreparedToolAction["operation"], { kind: "broker" }>,
    _opts: { signal?: AbortSignal; onUpdate?: (u: ToolProgress) => void },
  ): Promise<ExecutionResult> {
    const auth = {
      leaseId: envelope.envelopeId,
      actionDigest: action.actionDigest,
      expiresAt: envelope.expiresAt ?? Date.now() + 60_000,
      singleUseRequestId: operation.request.requestId,
    };
    const result = await this.broker.execute(operation.request, envelope, auth);
    if (result.status !== "succeeded") {
      return {
        state: "failed",
        error: result.error ?? {
          code: "BROKER_DENIED",
          message: `broker returned ${result.status}`,
          retryable: false,
        },
        evidence: {
          backend: "local-native",
          actionDigest: action.actionDigest,
          executorId: "broker",
          operationKind: "broker",
          effectiveDestinations: result.effectiveDestination
            ? [result.effectiveDestination]
            : [],
        },
      };
    }
    let outputText = "ok";
    if (result.output && this.artifacts) {
      try {
        const bytes = await this.artifacts.read(result.output);
        outputText = new TextDecoder().decode(bytes);
      } catch {
        outputText = `<broker artifact ${result.output.artifactId}>`;
      }
    } else if (result.output) {
      outputText = `<broker artifact ${result.output.artifactId}>`;
    }
    return {
      state: "succeeded",
      result: {
        output: outputText,
        success: true,
      },
      evidence: {
        backend: "local-native",
        actionDigest: action.actionDigest,
        executorId: "broker",
        operationKind: "broker",
        effectiveDestinations: result.effectiveDestination
          ? [result.effectiveDestination]
          : [],
      },
    };
  }
}

/**
 * Unsupported executor — returns `backend-unsupported` for operation kinds
 * the selected backend cannot enforce. Used for browser tools (T212): no
 * flag launches control-plane Chromium.
 */
export class UnsupportedExecutor implements OperationExecutor {
  readonly kind: PreparedToolAction["operation"]["kind"];

  constructor(kind: PreparedToolAction["operation"]["kind"]) {
    this.kind = kind;
  }

  async execute(action: PreparedToolAction): Promise<ExecutionResult> {
    throw new UnsupportedBackendError({
      backend: "local-native",
      operationKind: action.operation.kind,
      actionDigest: action.actionDigest,
    });
  }
}

/**
 * Trusted-host executor. Host tools are application authority and run the
 * registered callback directly — they are always audit-labelled and excluded
 * from agent-grant persistence. Enabled only by an operator allowlist in
 * server deployments.
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
    let cb = this.callbacks.get(operation.registrationId) ?? (operation.toolName ? this.callbacks.get(operation.toolName) : undefined);
    if (!cb) {
      const { getAllToolModules } = await import("../../domain/tool-executor.js");
      const mod = getAllToolModules().find((m) => m.definition.function.name === operation.registrationId || m.name === operation.registrationId);
      if (mod) {
        cb = async (args: unknown) => mod.handler(args as any);
      }
    }
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
