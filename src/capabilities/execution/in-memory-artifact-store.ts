/**
 * In-memory PreparationArtifactStore — Capabilities (spec 008, T202).
 *
 * Private, content-addressed artifact storage for one run. Artifacts are
 * named by random ID, verified by SHA-256 + length on every read, and
 * removed via `deleteRun`. Used by local surfaces and tests; the server
 * worker receives artifacts through the dispatch manifest instead.
 *
 * This is a Capabilities implementation injected at a composition root; it
 * imports only Foundations contracts.
 */
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import type {
  PreparationArtifactStore,
} from "../../foundations/contracts/execution-brokers.js";
import type { PreparedArtifactRef } from "../../foundations/contracts/prepared-action.js";

interface StoredArtifact {
  ref: PreparedArtifactRef;
  bytes: Uint8Array;
  runId?: string;
}

/**
 * In-memory artifact store. Suitable for a single-process run; cleared on
 * process exit. The local execution boundary uses this by default.
 */
export class InMemoryArtifactStore implements PreparationArtifactStore {
  private readonly artifacts = new Map<string, StoredArtifact>();

  async put(
    bytes: Uint8Array,
    mediaType: string,
    runId?: string,
  ): Promise<PreparedArtifactRef> {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const artifactId = randomUUID();
    const ref: PreparedArtifactRef = {
      artifactId,
      sha256,
      byteLength: bytes.byteLength,
      mediaType,
    };
    this.artifacts.set(artifactId, { ref, bytes, runId });
    return ref;
  }

  async read(ref: PreparedArtifactRef): Promise<Uint8Array> {
    const stored = this.artifacts.get(ref.artifactId);
    if (!stored) throw new Error(`Artifact not found: ${ref.artifactId}`);
    // Integrity check on every read.
    const actualSha = createHash("sha256").update(stored.bytes).digest("hex");
    if (actualSha !== ref.sha256 || stored.bytes.byteLength !== ref.byteLength) {
      throw new Error(`Artifact digest/length mismatch: ${ref.artifactId}`);
    }
    return stored.bytes;
  }

  async stat(
    ref: PreparedArtifactRef,
  ): Promise<{ exists: boolean; sha256: string; byteLength: number }> {
    const stored = this.artifacts.get(ref.artifactId);
    if (!stored) return { exists: false, sha256: "", byteLength: 0 };
    return {
      exists: true,
      sha256: stored.ref.sha256,
      byteLength: stored.ref.byteLength,
    };
  }

  async deleteRun(runId: string): Promise<void> {
    for (const [id, a] of this.artifacts) {
      if (a.runId === runId) this.artifacts.delete(id);
    }
  }
}
