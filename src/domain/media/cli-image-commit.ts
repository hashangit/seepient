/**
 * CLI Image Commit Bridge — Domain (spec 019/020).
 *
 * Constructs a FileCommitBroker and CapabilityEnvelope for CLI image generation,
 * ensuring Transport does not import Vendors directly.
 */
import { createHash } from "node:crypto";
import { FileCommitBroker } from "../../capabilities/execution/file-commit-broker.js";
import { InMemoryArtifactStore } from "../../capabilities/execution/in-memory-artifact-store.js";
import { probeCommitHelper, PackagedCommitHelper } from "../../vendors/native-fs-commit/index.js";
import type { CapabilityEnvelope } from "../../foundations/contracts/permission-policy.js";
import type { CommitHelper } from "../../foundations/contracts/execution-brokers.js";

export interface CliImageCommitContext {
  commitBroker: FileCommitBroker;
  envelope: CapabilityEnvelope;
}

export async function createCliImageCommitContext(
  destinations: string[],
  commitHelper?: CommitHelper,
): Promise<CliImageCommitContext> {
  const probe = commitHelper ? commitHelper.probe as any : await probeCommitHelper();
  const helper = (commitHelper as any) ?? new PackagedCommitHelper(probe);
  const artifacts = new InMemoryArtifactStore();
  const commitBroker = new FileCommitBroker({ artifacts, helper });

  const now = Date.now();
  const actionDigest = createHash("sha256")
    .update(`cli-image:${destinations.slice().sort().join(":")}:${now}`)
    .digest("hex");

  const envelope: CapabilityEnvelope = {
    version: 1,
    envelopeId: `env-cli-${now}`,
    principalId: "user",
    runId: `run-cli-${now}`,
    actionDigest,
    policyDigest: "operator-cli",
    expiresAt: now + 600_000,
    issuedAt: now,
    lifetime: {
      kind: "run",
      runId: `run-cli-${now}`,
      expiresAt: now + 600_000,
    },
    issuedBy: {
      kind: "principal",
      authorityId: "cli",
      authenticatedBy: "local",
    },
    capabilities: destinations.map((d) => ({
      kind: "commit-file" as const,
      path: d,
    })),
  };

  return { commitBroker, envelope };
}
