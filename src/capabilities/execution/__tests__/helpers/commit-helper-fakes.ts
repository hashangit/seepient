/**
 * Shared commit-helper test fixtures (spec 019, T003).
 *
 * Fake `NativeCommitHelper` implementations and capability-envelope builders
 * reused by the commit-path suites (broker, executors, policy e2e). Keep the
 * fakes honest: an unavailable helper reports `binary-missing` and answers
 * `primitive-unsupported`, exactly as the packaged wrapper does.
 */
import type { NativeCommitHelper, NativeCommitResult } from "../../../../vendors/native-fs-commit/index.js";
import type { CommitHelperProbe } from "../../../../vendors/native-fs-commit/index.js";
import type { CapabilityEnvelope } from "../../../../foundations/contracts/permission-policy.js";

/** Minimal action-scoped envelope carrying one commit-file capability. */
export function fakeCommitEnvelope(path: string): CapabilityEnvelope {
  return {
    version: 1,
    envelopeId: "e1",
    principalId: "u",
    runId: "r1",
    actionDigest: "d1",
    capabilities: [{ kind: "commit-file", path }],
    lifetime: { kind: "action", actionDigest: "d1", consumeOnce: true },
    issuedBy: { kind: "service", authorityId: "pe", authenticatedBy: "deployment" },
    issuedAt: 0,
    policyDigest: "dig",
  };
}

/** Probe builder matching the shapes `probeCommitHelper` can return. */
export function fakeProbe(opts: { available: boolean; reason?: CommitHelperProbe["reason"]; binaryPath?: string; digestVerified?: boolean }): CommitHelperProbe {
  return {
    available: opts.available,
    platform: process.platform,
    binaryPath: opts.available ? (opts.binaryPath ?? "/fake/bin") : opts.binaryPath,
    reason: opts.available ? undefined : (opts.reason ?? "binary-missing"),
    digestVerified: opts.digestVerified ?? false,
  };
}

export interface FakeHelperOptions {
  available: boolean;
  failWith?: NativeCommitResult["errorCode"];
}

/** Fake helper that reports success and echoes the input digest. */
export function fakeHelper(opts: FakeHelperOptions): NativeCommitHelper {
  return {
    available: opts.available,
    probe: fakeProbe({ available: opts.available }),
    async commit(req) {
      if (!opts.available) {
        return { ok: false, writtenSha256: "", errorCode: "primitive-unsupported" };
      }
      if (opts.failWith) {
        return { ok: false, writtenSha256: "", errorCode: opts.failWith };
      }
      const { createHash } = await import("node:crypto");
      const sha = createHash("sha256").update(req.content).digest("hex");
      return { ok: true, writtenSha256: sha };
    },
  };
}
