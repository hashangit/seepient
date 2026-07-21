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

/** Read the prepared bytes for a commit operation from the artifact store. */
async function readContent(
  artifacts: PreparationArtifactStore,
  ref: import("../../foundations/contracts/prepared-action.js").PreparedArtifactRef,
): Promise<Uint8Array> {
  return artifacts.read(ref);
}

/**
 * Commit-files executor. Validates every target via the FileCommitBroker
 * (which delegates to the native helper). Multi-file edits commit per-file
 * atomically; partial completion is reported honestly.
 */
export class CommitFilesExecutor implements OperationExecutor {
  readonly kind = "commit-files" as const;
  private readonly broker: FileCommitBroker;
  private readonly artifacts: PreparationArtifactStore;

  constructor(opts: { broker: FileCommitBroker; artifacts: PreparationArtifactStore }) {
    this.broker = opts.broker;
    this.artifacts = opts.artifacts;
  }

  async execute(
    action: PreparedToolAction,
    envelope: CapabilityEnvelope,
    operation: Extract<PreparedToolAction["operation"], { kind: "commit-files" }>,
    _opts: { signal?: AbortSignal; onUpdate?: (u: ToolProgress) => void },
  ): Promise<ExecutionResult> {
    const committed: string[] = [];
    const uncommitted: string[] = [];
    try {
      for (const commit of operation.commits) {
        const bytes = await readContent(this.artifacts, commit.content);
        await this.broker.commit({
          envelope,
          destination: commit.destination.canonicalPath,
          content: bytes,
          expected: commit.expected,
        });
        committed.push(commit.destination.canonicalPath);
      }
      return {
        state: "succeeded",
        result: {
          output: `Committed ${committed.length} file(s): ${committed.join(", ")}`,
          success: true,
        },
        evidence: {
          backend: "local-native",
          actionDigest: action.actionDigest,
          executorId: "commit-files",
          operationKind: "commit-files",
          committedTargets: committed,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Report partial completion honestly — no transactional claim.
      const remaining = operation.commits
        .filter((c) => !committed.includes(c.destination.canonicalPath))
        .map((c) => c.destination.canonicalPath);
      uncommitted.push(...remaining);
      return {
        state: "failed",
        error: {
          code: "COMMIT_FAILED",
          message: committed.length > 0
            ? `${message} (committed: ${committed.join(",")}; uncommitted: ${uncommitted.join(",")})`
            : message,
          retryable: false,
        },
        evidence: {
          backend: "local-native",
          actionDigest: action.actionDigest,
          executorId: "commit-files",
          operationKind: "commit-files",
          committedTargets: committed,
        },
      };
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

  constructor(opts: { broker: EffectBroker }) {
    this.broker = opts.broker;
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
    return {
      state: "succeeded",
      result: {
        output: result.output
          ? `<broker artifact ${result.output.artifactId}>`
          : "ok",
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
  private readonly callbacks: Map<string, (args: unknown) => Promise<string>>;

  constructor(callbacks: Map<string, (args: unknown) => Promise<string>>) {
    this.callbacks = callbacks;
  }

  async execute(
    action: PreparedToolAction,
    _envelope: CapabilityEnvelope,
    operation: Extract<PreparedToolAction["operation"], { kind: "trusted-host" }>,
    _opts: { signal?: AbortSignal; onUpdate?: (u: ToolProgress) => void },
  ): Promise<ExecutionResult> {
    const cb = this.callbacks.get(operation.registrationId);
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
      const output = await cb(operation.args);
      return {
        state: "succeeded",
        result: { output, success: true },
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
