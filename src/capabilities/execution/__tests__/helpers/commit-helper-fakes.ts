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

/**
 * Disk-backed fake helper: performs the helper's commit sequence for real
 * (expected verify → temp sibling → rename) so pipeline e2e tests can assert
 * actual disk state, without needing the compiled native binary.
 */
export function diskBackedFakeHelper(): NativeCommitHelper {
  return {
    available: true,
    probe: fakeProbe({ available: true }),
    async commit(req) {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const crypto = await import("node:crypto");
      if (req.expected?.exists && req.expected.sha256) {
        const current = await fs.readFile(req.destination).catch(() => undefined);
        const sha = current
          ? crypto.createHash("sha256").update(current).digest("hex")
          : undefined;
        if (sha !== req.expected.sha256) {
          return { ok: false, writtenSha256: "", errorCode: "snapshot-changed", message: "file changed since snapshot" };
        }
      }
      const dir = path.dirname(req.destination);
      const tmp = path.join(dir, `.fake-helper-${crypto.randomUUID().slice(0, 8)}`);
      try {
        await fs.writeFile(tmp, req.content);
        await fs.rename(tmp, req.destination);
      } catch (err) {
        return { ok: false, writtenSha256: "", errorCode: "io-error", message: (err as Error).message };
      }
      const sha = crypto.createHash("sha256").update(req.content).digest("hex");
      return { ok: true, writtenSha256: sha };
    },
  };
}
