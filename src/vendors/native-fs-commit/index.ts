/**
 * Native exact-commit helper wrapper — Vendors (spec 008, T203, D37/FR-007).
 *
 * Wraps the packaged `seepient-fs-commit` stable-Rust helper. Linux uses
 * restricted `openat2` resolution where available; macOS walks components
 * with directory-relative `openat`/`O_NOFOLLOW`. The helper owns the complete
 * validate/write/revalidate/rename sequence.
 *
 * If the helper or required platform primitive is unavailable, the wrapper
 * reports `exactCommit:false` and exact writes fail closed. There is NO
 * JavaScript-only security fallback — a TS path-allowlist cannot honestly
 * enforce exact-file semantics against symlink/TOCTOU attacks.
 *
 * This module is the ONLY place that may spawn the native helper. It is a
 * vendor adapter (platform-specific); Domain/Capabilities consume it through
 * the `NativeCommitHelper` interface.
 */
import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));

/** Result of the startup self-test. */
export interface CommitHelperProbe {
  available: boolean;
  /** Why the helper is unavailable, when `available` is false. */
  reason?: "binary-missing" | "primitive-unsupported" | "self-test-failed" | "digest-mismatch";
  /** Path to the resolved helper binary, when available. */
  binaryPath?: string;
  /** Platform the probe ran on. */
  platform: NodeJS.Platform;
  /** True only when the packaged binary matched the shipped manifest digest
   *  (spec 019, FR-009). The SEEPIENT_FS_COMMIT_BIN override bypasses the
   *  manifest check by design, so it reports false. */
  digestVerified: boolean;
}

/** A validated commit request handed to the native helper. */
export interface NativeCommitRequest {
  destination: string;
  content: Uint8Array;
  expected?: { exists: boolean; sha256?: string };
}

/** Result returned by the native helper. */
export interface NativeCommitResult {
  ok: boolean;
  /** SHA-256 of the bytes the helper wrote (caller verifies match). */
  writtenSha256: string;
  /** Error code on failure; one of a fixed set. */
  errorCode?:
    | "target-symlink"
    | "parent-symlink"
    | "parent-replaced"
    | "snapshot-changed"
    | "cross-device-rename"
    | "io-error"
    | "timeout"
    | "primitive-unsupported";
  message?: string;
}

/**
 * Vendor-neutral interface the file commit broker consumes.
 */
export interface NativeCommitHelper {
  readonly available: boolean;
  readonly probe: CommitHelperProbe;
  commit(req: NativeCommitRequest): Promise<NativeCommitResult>;
}

/** Resolve the packaged helper binary path for the current platform. */
function resolveBinaryPath(): string {
  // Published binaries live under dist/native-fs-commit/<platform>-<arch>/.
  // The wrapper prefers an env override, then the packaged location.
  const env = process.env.SEEPIENT_FS_COMMIT_BIN;
  if (env) return env;
  const platform = process.platform;
  const arch = process.arch;
  return path.join(
    currentDir,
    "..",
    "..",
    "native-fs-commit",
    `${platform}-${arch}`,
    "seepient-fs-commit",
  );
}

/** The manifest directory for a resolved binary (sibling of the platform dir). */
function resolveManifestPath(binaryPath: string): string {
  return path.join(path.dirname(path.dirname(binaryPath)), "manifest.json");
}

/**
 * sha256 the binary and compare against its manifest entry. Exported for
 * unit tests with fixture manifests.
 */
export async function verifyPackagedBinary(
  binaryPath: string,
  manifestPath: string,
  platform: NodeJS.Platform,
  arch: string = process.arch,
): Promise<{ ok: boolean; reason?: "digest-mismatch" }> {
  const { readFile } = await import("node:fs/promises");
  let manifest: { version?: number; binaries?: Record<string, { sha256?: string }> };
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf-8"));
  } catch {
    // Missing or unreadable manifest: fail closed — an install whose
    // integrity cannot be verified is indistinguishable from a tampered one.
    return { ok: false, reason: "digest-mismatch" };
  }
  if (manifest.version !== 1) {
    // Unknown manifest version: fail closed (spec 019 data-model).
    return { ok: false, reason: "digest-mismatch" };
  }
  const entry = manifest.binaries?.[`${platform}-${arch}`];
  if (!entry || typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
    return { ok: false, reason: "digest-mismatch" };
  }
  const bytes = await readFile(binaryPath);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== entry.sha256) {
    return { ok: false, reason: "digest-mismatch" };
  }
  return { ok: true };
}

/**
 * Startup self-test. Resolution order:
 *  1. platform gate (darwin/linux only; win32 → primitive-unsupported),
 *  2. `SEEPIENT_FS_COMMIT_BIN` override — exec-bit check only, EXEMPT from
 *     the manifest check BY DESIGN (developer-built binary; documented as an
 *     explicit trust decision, spec 019 D11),
 *  3. packaged layout — digest verified against the shipped manifest
 *     (fail closed on mismatch: `digest-mismatch`),
 *  4. source layout (tsx dev runs) — no manifest exists by design; the
 *     binary is available but `digestVerified:false` (from-source story,
 *     spec 019 QS-1.5).
 */
export async function probeCommitHelper(): Promise<CommitHelperProbe> {
  const platform = process.platform;
  if (platform !== "darwin" && platform !== "linux") {
    return {
      available: false,
      reason: "primitive-unsupported",
      platform,
      digestVerified: false,
    };
  }
  const binaryPath = resolveBinaryPath();
  const envOverride = Boolean(process.env.SEEPIENT_FS_COMMIT_BIN);
  try {
    await access(binaryPath, constants.X_OK);
  } catch {
    // Helper binary missing: fail closed
    return { available: false, binaryPath: undefined, platform, reason: "binary-missing", digestVerified: false };
  }
  if (envOverride) {
    return { available: true, binaryPath, platform, digestVerified: false };
  }
  // Manifest verification applies ONLY to the packaged (dist) layout; the
  // source layout never carries a manifest (CI is the only manifest
  // generator — contract: commits must never include a hand-written one).
  const isPackagedLayout = currentDir.split(path.sep).includes("dist");
  if (isPackagedLayout) {
    const verification = await verifyPackagedBinary(
      binaryPath,
      resolveManifestPath(binaryPath),
      platform,
    );
    if (!verification.ok) {
      return { available: false, binaryPath: undefined, platform, reason: "digest-mismatch", digestVerified: false };
    }
    return { available: true, binaryPath, platform, digestVerified: true };
  }
  return { available: true, binaryPath, platform, digestVerified: false };
}

/**
 * Wraps the native helper. The wrapper NEVER falls back to a JS-only path:
 * if `probe.available` is false, `commit()` returns a `primitive-unsupported`
 * error and the broker fails closed.
 */
export class PackagedCommitHelper implements NativeCommitHelper {
  readonly probe: CommitHelperProbe;

  constructor(probe?: CommitHelperProbe) {
    this.probe = probe ?? { available: false, reason: "binary-missing", platform: process.platform, digestVerified: false };
  }

  get available(): boolean {
    return this.probe.available;
  }

  async commit(req: NativeCommitRequest): Promise<NativeCommitResult> {
    if (!this.probe.available || !this.probe.binaryPath) {
      // No JS fallback exists (spec 019 FR-004): an unavailable probe always
      // answers primitive-unsupported and the broker fails closed.
      return {
        ok: false,
        writtenSha256: "",
        errorCode: "primitive-unsupported",
        message: "Native exact-commit helper unavailable; no JS fallback",
      };
    }

    // The real invocation passes destination + content over stdin and reads
    // a JSON result over stdout. The helper owns the full validate/write/
    // revalidate/rename sequence. This wrapper constructs the invocation and
    // verifies the returned digest matches the input bytes.
    const expectedSha = createHash("sha256").update(req.content).digest("hex");
    try {
      const result = await this.invoke(req);
      if (!result.ok) return result;
      // Verify the helper's reported digest matches what we sent.
      if (result.writtenSha256 !== expectedSha) {
        return {
          ok: false,
          writtenSha256: result.writtenSha256,
          errorCode: "io-error",
          message: "Helper reported a digest that does not match the input",
        };
      }
      return result;
    } catch (err) {
      return {
        ok: false,
        writtenSha256: "",
        errorCode: "io-error",
        message: (err as Error).message,
      };
    }
  }

  /**
   * Spawn the helper, pass content over stdin, parse JSON result. The helper
   * receives destination as an argv argument (never shell-interpolated) and
   * content as raw stdin bytes.
   */
  private invoke(req: NativeCommitRequest): Promise<NativeCommitResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.probe.binaryPath!, [
        "--commit",
        req.destination,
        ...(req.expected ? ["--expected-sha256", req.expected.sha256 ?? ""] : []),
      ], { stdio: ["pipe", "pipe", "pipe"], shell: false });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (b: Buffer) => (stdout += b.toString()));
      child.stderr.on("data", (b: Buffer) => (stderr += b.toString()));
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) {
          resolve({
            ok: false,
            writtenSha256: "",
            errorCode: "io-error",
            message: stderr || `helper exited ${code}`,
          });
          return;
        }
        try {
          const parsed = JSON.parse(stdout) as NativeCommitResult;
          resolve(parsed);
        } catch (err) {
          reject(err);
        }
      });
      child.stdin.end(Buffer.from(req.content));
    });
  }
}
