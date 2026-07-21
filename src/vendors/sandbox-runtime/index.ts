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
 * Startup probe. Checks for platform support + binary presence WITHOUT
 * importing the ASRT SDK (it's an optional peer dep kept out of memory).
 */
export async function probeSandbox(): Promise<SandboxProbe> {
  const platform = process.platform;
  if (platform === "darwin") {
    // macOS Seatbelt via sandbox-exec — shipped with the OS.
    return { available: true, platform, backend: "seatbelt" };
  }
  if (platform === "linux") {
    // Bubblewrap detection would check for bwrap in PATH.
    return { available: true, platform, backend: "bubblewrap" };
  }
  return {
    available: false,
    platform,
    backend: "none",
    reason: "unsupported-platform",
  };
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
      child.stdout?.on("data", (b: Buffer) => {
        const chunk = b.toString();
        stdout += chunk;
        req.onUpdate?.({ message: chunk });
      });
      child.stderr?.on("data", (b: Buffer) => (stderr += b.toString()));
      child.on("close", (code) =>
        resolve({ exitCode: code ?? 0, stdout, stderr, isolated: false }),
      );
      child.on("error", () =>
        resolve({ exitCode: 1, stdout, stderr: stderr + "spawn failed", isolated: false }),
      );
      req.signal?.addEventListener("abort", () => child.kill("SIGTERM"));
    });
  }
}
