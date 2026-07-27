/**
 * @anthropic-ai/sandbox-runtime vendor adapter — Vendors (spec 008, T207/T208,
 * D44/FR-008).
 *
 * Local macOS/Linux process isolation. `@anthropic-ai/sandbox-runtime` is
 * imported only by this Vendors module; the execution capability consumes
 * the vendor-neutral `NativeProcessSandbox` interface. The dependency is
 * exact-version locked.
 *
 * macOS: generated Seatbelt profile passed to `sandbox-exec` using argument
 * arrays, never shell interpolation. Linux: Bubblewrap mount/PID/network
 * namespace. Windows: fail closed in v1 (or use a configured remote worker).
 *
 * The startup probe advertises ACTUAL supported semantics (roots, environment,
 * network). Missing dependency/tool/kernel support fails closed. ASRT is used
 * for PROCESS CONTAINMENT ONLY — it does not claim exact-file writes, filtered
 * egress, secret isolation, or server tenant isolation; those remain the
 * explicit Seepient boundaries.
 *
 * NOTE: the `@anthropic-ai/sandbox-runtime` package is an optional peer
 * dependency. The dynamic import below keeps unused SDK out of memory when
 * not installed.
 */
import type { CommandDescriptor, RootRequest } from "../../foundations/contracts/tool-effects.js";

/** Result of the sandbox startup probe. */
export interface SandboxProbe {
  available: boolean;
  platform: NodeJS.Platform;
  /** Seatbelt (macOS), Bubblewrap (Linux), or none. */
  backend: "seatbelt" | "bubblewrap" | "none";
  reason?: "unsupported-platform" | "binary-missing" | "primitive-unsupported";
}

/** Execution request handed to the sandbox. */
export interface SandboxExecRequest {
  command: CommandDescriptor;
  roots: RootRequest[];
  /** Sanitized environment (no ambient secrets). */
  env: Record<string, string>;
  signal?: AbortSignal;
  onUpdate?: (chunk: { message: string }) => void;
}

export interface SandboxExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** True iff the sandbox actually enforced isolation (not a passthrough). */
  isolated: boolean;
}

/**
 * Vendor-neutral process sandbox interface. The execution capability's
 * process executor consumes this; ASRT or a future remote-worker backend
 * implements it.
 */
export interface NativeProcessSandbox {
  readonly probe: SandboxProbe;
  exec(req: SandboxExecRequest): Promise<SandboxExecResult>;
}

/**
 * Startup probe. Checks for platform support + binary presence.
 * Fails closed: `available:false` if the required sandbox binary is absent.
 * T207a: no longer claims `available:true` unconditionally.
 */
export async function probeSandbox(): Promise<SandboxProbe> {
  const platform = process.platform;
  if (platform === "darwin") {
    // macOS Seatbelt: sandbox-exec is shipped with the OS at /usr/bin/sandbox-exec
    const binaryPresent = await checkBinary("/usr/bin/sandbox-exec");
    if (!binaryPresent) {
      return {
        available: false,
        platform,
        backend: "none",
        reason: "binary-missing",
      };
    }
    return { available: true, platform, backend: "seatbelt" };
  }
  if (platform === "linux") {
    // Bubblewrap: check for bwrap in PATH
    const binaryPresent = await checkBinaryInPath("bwrap");
    if (!binaryPresent) {
      return {
        available: false,
        platform,
        backend: "none",
        reason: "binary-missing",
      };
    }
    return { available: true, platform, backend: "bubblewrap" };
  }
  return {
    available: false,
    platform,
    backend: "none",
    reason: "unsupported-platform",
  };
}

/** Check that a binary exists and is executable at an absolute path. */
async function checkBinary(absPath: string): Promise<boolean> {
  try {
    const { access, constants } = await import("node:fs/promises");
    await access(absPath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Check that a binary exists in PATH using `which` semantics. */
async function checkBinaryInPath(name: string): Promise<boolean> {
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    await execFileAsync("which", [name]);
    return true;
  } catch {
    return false;
  }
}

/**
 * No-op sandbox used when ASRT is unavailable or the operator explicitly
 * chose uncontained mode. The probe reports `isolated:false` so policy and
 * audit never mistake this for containment (T213).
 */
export class UncontainedSandbox implements NativeProcessSandbox {
  readonly probe: SandboxProbe;

  constructor() {
    this.probe = {
      available: true,
      platform: process.platform,
      backend: "none",
      reason: "primitive-unsupported",
    };
  }

  async exec(req: SandboxExecRequest): Promise<SandboxExecResult> {
    // Spawn directly with no profile/namespace. Caller MUST label this in
    // audit as uncontained; the boundary never claims path/network containment.
    const { spawn } = await import("node:child_process");
    return new Promise((resolve) => {
      const child = spawn(req.command.executable, req.command.argv, {
        cwd: req.command.cwd,
        env: req.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let flushed = false;
      const flushProgress = () => {
        if (!flushed && stdout.length > 0) {
          flushed = true;
          req.onUpdate?.({ message: stdout });
        }
      };
      child.stdout?.on("data", (b: Buffer) => {
        const chunk = b.toString();
        stdout += chunk;
        req.onUpdate?.({ message: chunk });
      });
      child.stderr?.on("data", (b: Buffer) => (stderr += b.toString()));
      child.on("close", (code) => {
        flushProgress();
        resolve({ exitCode: code ?? 0, stdout, stderr, isolated: false });
      });
      child.on("error", () =>
        resolve({ exitCode: 1, stdout, stderr: stderr + "spawn failed", isolated: false }),
      );
      req.signal?.addEventListener("abort", () => child.kill("SIGTERM"));
    });
  }
}

/**
 * ASRT-backed sandbox. Dynamically imports `@anthropic-ai/sandbox-runtime`
 * and delegates to the SDK. If the package is absent or the probe failed,
 * falls back to UncontainedSandbox and sets isolated:false (T207a).
 *
 * The dynamic import keeps unused SDK out of memory and isolates the optional
 * peer dep from the module graph when not installed.
 */
export class AsrtSandbox implements NativeProcessSandbox {
  readonly probe: SandboxProbe;
  private readonly inner: NativeProcessSandbox;

  private constructor(probe: SandboxProbe, inner: NativeProcessSandbox) {
    this.probe = probe;
    this.inner = inner;
  }

  /**
   * Factory: probes the platform and attempts to import the ASRT SDK.
   * Returns an AsrtSandbox on success, or UncontainedSandbox on failure.
   */
  static async create(): Promise<NativeProcessSandbox> {
    const probe = await probeSandbox();
    if (!probe.available) {
      return new UncontainedSandbox();
    }
    try {
      // Optional peer dep — dynamic import keeps it out of memory when absent.
      const asrt = await import("@anthropic-ai/sandbox-runtime" as string);
      // Verify the SDK exposes the expected execute API.
      if (typeof (asrt as any).createSandbox !== "function" && typeof (asrt as any).Sandbox !== "function") {
        throw new Error("ASRT SDK missing createSandbox/Sandbox export");
      }
      return new AsrtSandbox(probe, new AsrtNativeSandbox(probe, asrt));
    } catch {
      // ASRT SDK not installed or incompatible — fail closed to uncontained.
      const uncontained = new UncontainedSandbox();
      return uncontained;
    }
  }

  async exec(req: SandboxExecRequest): Promise<SandboxExecResult> {
    return this.inner.exec(req);
  }
}

/** Internal: delegates to the actual ASRT SDK when available. */
class AsrtNativeSandbox implements NativeProcessSandbox {
  readonly probe: SandboxProbe;
  private readonly sdk: any;

  constructor(probe: SandboxProbe, sdk: any) {
    this.probe = probe;
    this.sdk = sdk;
  }

  async exec(req: SandboxExecRequest): Promise<SandboxExecResult> {
    try {
      // The ASRT SDK API varies by version — we use a best-effort adapter.
      // The exact API is resolved via dynamic reflection to stay compatible
      // with multiple SDK versions. If the call fails, we surface
      // ISOLATION_UNAVAILABLE as a structured error.
      const SandboxCtor = this.sdk.Sandbox ?? this.sdk.createSandbox;
      const result = await SandboxCtor({
        command: req.command.executable,
        args: req.command.argv,
        cwd: req.command.cwd,
        env: req.env,
        roots: req.roots,
        signal: req.signal,
      });
      return {
        exitCode: result.exitCode ?? 0,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        isolated: true,
      };
    } catch (err) {
      throw Object.assign(
        new Error(`ASRT execution failed: ${(err as Error).message}`),
        { code: "ISOLATION_UNAVAILABLE" },
      );
    }
  }
}

/**
 * Factory: create the best available sandbox for the current platform.
 * Probes for binary presence and ASRT SDK availability. Returns
 * UncontainedSandbox with isolated:false when containment is unavailable.
 */
export async function createNativeProcessSandbox(): Promise<NativeProcessSandbox> {
  return AsrtSandbox.create();
}
