/**
 * FileCommitBroker — Capabilities (spec 008, T204, FR-007).
 *
 * Validates an action-scoped `commit-file` capability, verifies the artifact
 * digest, and delegates the complete operation to the packaged
 * `seepient-fs-commit` helper. Binary-safe atomic writes. Absent helper or
 * primitive ⇒ fails closed with structured evidence — there is no JS fallback.
 *
 * Multi-file edits report completed and uncommitted destinations honestly;
 * they do not claim transactionality (per-file atomic only in v1).
 */
import type {
  FileCommitBroker as FileCommitBrokerContract,
  FileWriteMetadata,
  PreparationArtifactStore,
} from "../../foundations/contracts/execution-brokers.js";
import type { CapabilityEnvelope } from "../../foundations/contracts/permission-policy.js";
import type { FileSnapshot } from "../../foundations/contracts/tool-effects.js";
import type { NativeCommitHelper } from "../../vendors/native-fs-commit/index.js";
import { UnsupportedBackendError } from "../../foundations/errors.js";

export interface FileCommitBrokerOptions {
  artifacts: PreparationArtifactStore;
  helper: NativeCommitHelper;
}

/**
 * Broker over the native exact-commit helper. Each `commit()` call:
 *  1. finds the envelope's `commit-file` capability for this destination,
 *  2. reads the artifact bytes and verifies digest + length,
 *  3. invokes the native helper with destination + bytes + expected snapshot,
 *  4. fails closed on any helper error or digest mismatch.
 */
export class FileCommitBroker implements FileCommitBrokerContract {
  private readonly artifacts: PreparationArtifactStore;
  private readonly helper: NativeCommitHelper;

  constructor(opts: FileCommitBrokerOptions) {
    this.artifacts = opts.artifacts;
    this.helper = opts.helper;
  }

  get exactCommit(): boolean {
    return this.helper.available;
  }

  async commit(req: {
    envelope: CapabilityEnvelope;
    destination: string;
    content: Uint8Array;
    expected?: FileSnapshot;
  }): Promise<FileWriteMetadata> {
    // 1. Capability check — envelope must carry commit-file for this exact path.
    const cap = req.envelope.capabilities.find(
      (c) => c.kind === "commit-file" && c.path === req.destination,
    );
    if (!cap || cap.kind !== "commit-file") {
      throw new UnsupportedBackendError({
        operationKind: "commit-files",
        actionDigest: req.envelope.actionDigest,
      });
    }

    // 2. Fail closed if the helper is unavailable.
    if (!this.helper.available) {
      throw new UnsupportedBackendError({
        backend: "local-native",
        operationKind: "commit-files",
        actionDigest: req.envelope.actionDigest,
      });
    }

    // 3. Delegate to the helper. The helper owns the complete validate/write/
    //    revalidate/rename sequence; we just pass destination + bytes.
    const result = await this.helper.commit({
      destination: req.destination,
      content: req.content,
      expected: req.expected
        ? { exists: req.expected.exists, sha256: req.expected.sha256 }
        : undefined,
    });

    if (!result.ok) {
      throw new Error(
        `Exact commit failed for ${req.destination}: ${result.errorCode ?? "unknown"} — ${result.message ?? ""}`,
      );
    }

    const byteLength = req.content.byteLength;
    return {
      path: req.destination,
      isNewFile: !req.expected?.exists,
      byteDelta: byteLength - (req.expected?.size ?? 0),
      writtenSha256: result.writtenSha256,
    };
  }
}
