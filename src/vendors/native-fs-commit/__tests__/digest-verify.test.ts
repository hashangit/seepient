/**
 * Probe digest-verification tests (spec 019 FR-009/T030, QS-1.3).
 *
 * A tampered or missing manifest digest makes the probe report unavailable
 * (fail closed); a valid manifest verifies the binary. The
 * SEEPIENT_FS_COMMIT_BIN override is exempt by design (documented trust
 * decision, D11).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { verifyPackagedBinary } from "../index.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seepient-fs-digest-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function writeFixture(binaryBytes: Buffer, manifest: unknown): { binaryPath: string; manifestPath: string } {
  const platformDir = join(dir, "native-fs-commit", `${process.platform}-${process.arch}`);
  mkdirSync(platformDir, { recursive: true });
  const binaryPath = join(platformDir, "seepient-fs-commit");
  writeFileSync(binaryPath, binaryBytes);
  const manifestPath = join(dir, "native-fs-commit", "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return { binaryPath, manifestPath };
}

function manifestFor(_binaryPath: string, sha256: string, version = 1): unknown {
  const platform = `${process.platform}-${process.arch}`;
  return {
    version,
    generatedAt: "2026-09-01T00:00:00Z",
    binaries: { [platform]: { path: `${platform}/seepient-fs-commit`, sha256, bytes: 4 } },
  };
}

describe("packaged-binary digest verification (spec 019 SC-5)", () => {
  it("valid manifest + untampered binary verifies", async () => {
    const bytes = Buffer.from("fake-binary");
    const expectedPath = join(dir, "native-fs-commit", `${process.platform}-${process.arch}`, "seepient-fs-commit");
    const { binaryPath, manifestPath } = writeFixture(bytes, manifestFor(expectedPath, createHash("sha256").update(bytes).digest("hex")));
    const result = await verifyPackagedBinary(binaryPath, manifestPath, process.platform);
    expect(result).toEqual({ ok: true });
  });

  it("flipped byte in the binary → digest-mismatch (fail closed)", async () => {
    const bytes = Buffer.from("fake-binary");
    const tampered = Buffer.from("fake-binary!");
    const expectedPath = join(dir, "native-fs-commit", `${process.platform}-${process.arch}`, "seepient-fs-commit");
    const { binaryPath, manifestPath } = writeFixture(bytes, manifestFor(expectedPath, createHash("sha256").update(bytes).digest("hex")));
    // Overwrite the binary with different content of the same length+1
    writeFileSync(binaryPath, tampered);
    const result = await verifyPackagedBinary(binaryPath, manifestPath, process.platform);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("digest-mismatch");
  });

  it("missing manifest → digest-mismatch (fail closed)", async () => {
    const bytes = Buffer.from("fake-binary");
    const platformDir = join(dir, "native-fs-commit", `${process.platform}-${process.arch}`);
    mkdirSync(platformDir, { recursive: true });
    const binaryPath = join(platformDir, "seepient-fs-commit");
    writeFileSync(binaryPath, bytes);
    const result = await verifyPackagedBinary(binaryPath, join(dir, "native-fs-commit", "manifest.json"), process.platform);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("digest-mismatch");
  });

  it("unknown manifest version → digest-mismatch (fail closed)", async () => {
    const bytes = Buffer.from("fake-binary");
    const expectedPath = join(dir, "native-fs-commit", `${process.platform}-${process.arch}`, "seepient-fs-commit");
    const { binaryPath, manifestPath } = writeFixture(bytes, manifestFor(expectedPath, createHash("sha256").update(bytes).digest("hex"), 999));
    const result = await verifyPackagedBinary(binaryPath, manifestPath, process.platform);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("digest-mismatch");
  });

  it("manifest entry for another platform → digest-mismatch (fail closed)", async () => {
    const bytes = Buffer.from("fake-binary");
    const platformDir = join(dir, "native-fs-commit", `${process.platform}-${process.arch}`);
    mkdirSync(platformDir, { recursive: true });
    const binaryPath = join(platformDir, "seepient-fs-commit");
    writeFileSync(binaryPath, bytes);
    const manifestPath = join(dir, "native-fs-commit", "manifest.json");
    writeFileSync(manifestPath, JSON.stringify({
      version: 1,
      binaries: { "other-platform": { path: "other-platform/seepient-fs-commit", sha256: createHash("sha256").update(bytes).digest("hex") } },
    }));
    const result = await verifyPackagedBinary(binaryPath, manifestPath, process.platform);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("digest-mismatch");
  });
});
