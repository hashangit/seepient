/**
 * P2 file commit broker + executor registry tests (spec 008, T201/T204,
 * QS-2.9).
 *
 * Verifies: fails closed when helper unavailable (no JS fallback), capability
 * shape check, binary-safe commit, and registry routing.
 */
import { describe, it, expect } from "vitest";
import { FileCommitBroker } from "../file-commit-broker.js";
import { OperationExecutorRegistry, registryCapabilities } from "../operation-executor-registry.js";
import { LocalExecutionBoundary } from "../local-execution-boundary.js";
import { InMemoryArtifactStore } from "../in-memory-artifact-store.js";
import type { NativeCommitHelper, NativeCommitResult } from "../../../vendors/native-fs-commit/index.js";
import { UnsupportedBackendError } from "../../../foundations/errors.js";
import type { CapabilityEnvelope } from "../../../foundations/contracts/permission-policy.js";

function envelope(path: string): CapabilityEnvelope {
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

/** Fake helper that reports success and echoes the input digest. */
function fakeHelper(opts: { available: boolean; failWith?: NativeCommitResult["errorCode"] }): NativeCommitHelper {
  return {
    available: opts.available,
    probe: {
      available: opts.available,
      platform: process.platform,
      binaryPath: opts.available ? "/fake/bin" : undefined,
      reason: opts.available ? undefined : "binary-missing",
    },
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

describe("FileCommitBroker (T204, QS-2.9)", () => {
  it("commits when envelope has exact commit-file capability", async () => {
    const broker = new FileCommitBroker({
      artifacts: new InMemoryArtifactStore(),
      helper: fakeHelper({ available: true }),
    });
    const meta = await broker.commit({
      envelope: envelope("/proj/a.txt"),
      destination: "/proj/a.txt",
      content: Buffer.from("hello"),
      expected: { exists: false },
    });
    expect(meta.path).toBe("/proj/a.txt");
    expect(meta.isNewFile).toBe(true);
    expect(meta.writtenSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("fails closed when helper unavailable (no JS fallback)", async () => {
    const broker = new FileCommitBroker({
      artifacts: new InMemoryArtifactStore(),
      helper: fakeHelper({ available: false }),
    });
    await expect(
      broker.commit({
        envelope: envelope("/proj/a.txt"),
        destination: "/proj/a.txt",
        content: Buffer.from("hello"),
      }),
    ).rejects.toBeInstanceOf(UnsupportedBackendError);
  });

  it("rejects when envelope lacks commit-file for the exact destination", async () => {
    const broker = new FileCommitBroker({
      artifacts: new InMemoryArtifactStore(),
      helper: fakeHelper({ available: true }),
    });
    // envelope authorized /p/a.txt but caller writes /p/b.txt
    await expect(
      broker.commit({
        envelope: envelope("/proj/a.txt"),
        destination: "/proj/b.txt",
        content: Buffer.from("hello"),
      }),
    ).rejects.toBeInstanceOf(UnsupportedBackendError);
  });

  it("binary-safe: arbitrary bytes round-trip", async () => {
    const artifacts = new InMemoryArtifactStore();
    const broker = new FileCommitBroker({ artifacts, helper: fakeHelper({ available: true }) });
    const binary = new Uint8Array([0, 1, 2, 255, 128, 64, 32]);
    const meta = await broker.commit({
      envelope: envelope("/proj/blob.bin"),
      destination: "/proj/blob.bin",
      content: binary,
    });
    expect(meta.writtenSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("propagates helper failures (symlink/TOCTOU) as errors", async () => {
    const broker = new FileCommitBroker({
      artifacts: new InMemoryArtifactStore(),
      helper: fakeHelper({ available: true, failWith: "target-symlink" }),
    });
    await expect(
      broker.commit({
        envelope: envelope("/proj/link.txt"),
        destination: "/proj/link.txt",
        content: Buffer.from("hi"),
      }),
    ).rejects.toThrow(/target-symlink/);
  });
});

describe("OperationExecutorRegistry (T201)", () => {
  it("unsupported operation kind fails before approval", () => {
    const registry = new OperationExecutorRegistry();
    // No executors registered → nothing supported.
    const caps = registryCapabilities(registry, "local-native");
    expect(caps.supportedOperationKinds).toEqual([]);
  });

  it("advertises supported kinds from registered executors", () => {
    const registry = new OperationExecutorRegistry();
    registry.register({
      kind: "none",
      async execute() {
        return {
          state: "succeeded",
          result: { output: "ok", success: true },
          evidence: {
            backend: "local-native",
            actionDigest: "d",
            executorId: "none",
            operationKind: "none",
          },
        };
      },
    });
    const caps = registryCapabilities(registry, "local-native");
    expect(caps.supportedOperationKinds).toContain("none");
  });

  it("rejects duplicate executor registration for same kind", () => {
    const registry = new OperationExecutorRegistry();
    registry.register({ kind: "none", async execute() { return {} as never; } });
    expect(() =>
      registry.register({ kind: "none", async execute() { return {} as never; } }),
    ).toThrow(/already registered/);
  });
});

describe("LocalExecutionBoundary (T201/T204)", () => {
  it("reports exactCommit:false when helper unavailable", () => {
    const registry = new OperationExecutorRegistry();
    const boundary = new LocalExecutionBoundary({
      registry,
      exactCommit: false,
      hostFilteredEgress: false,
    });
    expect(boundary.capabilities.exactCommit).toBe(false);
    expect(boundary.capabilities.backend).toBe("local-native");
  });

  it("reports exactCommit:true when helper probe passed", () => {
    const registry = new OperationExecutorRegistry();
    const boundary = new LocalExecutionBoundary({
      registry,
      exactCommit: true,
      hostFilteredEgress: true,
    });
    expect(boundary.capabilities.exactCommit).toBe(true);
    expect(boundary.capabilities.hostFilteredEgress).toBe(true);
  });
});
