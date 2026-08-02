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
import { spawn } from "node:child_process";

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
      available: false,
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
      let lastFlushedLen = 0;

      const emitProgress = (chunk: string) => {
        if (chunk.length > 0) {
          req.onUpdate?.({ message: chunk });
        }
      };

      child.stdout?.on("data", (b: Buffer) => {
        const chunk = b.toString();
        stdout += chunk;
        lastFlushedLen = stdout.length;
        emitProgress(chunk);
      });
      child.stderr?.on("data", (b: Buffer) => (stderr += b.toString()));

      let exitCode = 0;
      let closed = false;
      let stdoutEnded = !child.stdout;

      const checkDone = () => {
        if (closed && stdoutEnded) {
          if (stdout.length > lastFlushedLen) {
            const remaining = stdout.slice(lastFlushedLen);
            emitProgress(remaining);
          }
          resolve({ exitCode, stdout, stderr, isolated: false });
        }
      };

      child.stdout?.on("end", () => {
        stdoutEnded = true;
        checkDone();
      });

      child.on("close", (code) => {
        exitCode = code ?? 0;
        closed = true;
        checkDone();
      });
      req.signal?.addEventListener("abort", () => child.kill("SIGTERM"));
    });
  }
}

/**
 * ASRT-backed sandbox (SDK 0.0.67 API). Dynamically imports
 * `@anthropic-ai/sandbox-runtime` and drives its session-scoped
 * `SandboxManager` singleton: `initialize()` once (platform + dependency
 * check), then `wrapWithSandboxArgv()` per command so the spawned argv runs
 * under a Seatbelt/Bubblewrap profile. If the package is absent, the API
 * changed, or initialization fails, falls back to UncontainedSandbox and
 * sets isolated:false (T207a).
 *
 * The dynamic import keeps unused SDK out of memory and isolates the
 * optional peer dep from the module graph when not installed.
 */
export class AsrtSandbox implements NativeProcessSandbox {
  readonly probe: SandboxProbe;
  private readonly manager: SrtSandboxManager;
  private initPromise: Promise<boolean> | undefined;

  private constructor(probe: SandboxProbe, manager: SrtSandboxManager) {
    this.probe = probe;
    this.manager = manager;
  }

  /**
   * Factory: probes the platform, imports the SDK, and verifies the
   * SandboxManager API + a successful session initialize. Returns an
   * AsrtSandbox on success, or UncontainedSandbox on any failure.
   */
  static async create(): Promise<NativeProcessSandbox> {
    const probe = await probeSandbox();
    if (!probe.available) {
      return new UncontainedSandbox();
    }
    try {
      // Optional peer dep — dynamic import keeps it out of memory when absent.
      const sdk = (await import("@anthropic-ai/sandbox-runtime" as string)) as {
        SandboxManager?: SrtSandboxManager;
      };
      const manager = sdk.SandboxManager;
      if (
        typeof manager?.initialize !== "function" ||
        typeof manager.wrapWithSandboxArgv !== "function"
      ) {
        throw new Error("ASRT SDK missing SandboxManager API");
      }
      const sandbox = new AsrtSandbox(probe, manager);
      const ready = await sandbox.init();
      return ready ? sandbox : new UncontainedSandbox();
    } catch {
      // ASRT SDK not installed or incompatible — fail closed to uncontained.
      return new UncontainedSandbox();
    }
  }

  /**
   * Session-scoped SDK initialization. Idempotent: SRT's singleton is
   * process-wide, so a second boundary reuses the same session. Deny-all
   * network and empty filesystem grants at the session level — the per-exec
   * roots travel in the per-call customConfig.
   */
  private async init(): Promise<boolean> {
    this.initPromise ??= this.doInit();
    return this.initPromise;
  }

  private async doInit(): Promise<boolean> {
    try {
      await this.manager.initialize({
        network: { allowedDomains: [], deniedDomains: ["*"] },
        filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
      });
      return this.manager.isSandboxingEnabled();
    } catch {
      return false;
    }
  }

  async exec(req: SandboxExecRequest): Promise<SandboxExecResult> {
    const ready = await this.init();
    if (!ready) {
      throw Object.assign(new Error("Sandbox runtime not operational"), {
        code: "ISOLATION_UNAVAILABLE",
      });
    }
    try {
      // The sanitized env (T207: no ambient secrets) is baked into the
      // wrapped command line; SRT's wrapper runs `env <SRT vars> <cmd>` and
      // the SDK returns `process.env` for spawning, so the child must spawn
      // with the SANITIZED env, not the SDK's, or secrets would re-enter.
      const envPairs = Object.entries(req.env)
        .map(([k, v]) => `${k}=${shellQuote(v)}`)
        .join(" ");
      const args = req.command.argv.map(shellQuote).join(" ");
      const commandLine = `${envPairs} ${shellQuote(req.command.executable)}${args ? ` ${args}` : ""}`;
      const wrapped = await this.manager.wrapWithSandboxArgv(
        commandLine,
        undefined,
        { filesystem: filesystemConfigFor(req.roots) },
        req.signal,
        req.command.cwd,
      );
      return await spawnSandboxed(wrapped, req);
    } finally {
      await this.manager.cleanupAfterCommand();
    }
  }
}

/** Shell-quote one token for the `bash -c` line SRT wraps. */
function shellQuote(token: string): string {
  return `'${token.replace(/'/g, "'\\''")}'`;
}

/** Map boundary root requests onto the SRT filesystem config. */
function filesystemConfigFor(
  roots: RootRequest[],
): { allowRead?: string[]; allowWrite?: string[] } {
  const allowRead = new Set<string>();
  const allowWrite = new Set<string>();
  for (const r of roots) {
    allowRead.add(r.canonicalRoot);
    if (r.access === "write") allowWrite.add(r.canonicalRoot);
  }
  return {
    ...(allowRead.size > 0 ? { allowRead: [...allowRead] } : {}),
    ...(allowWrite.size > 0 ? { allowWrite: [...allowWrite] } : {}),
  };
}

/** Spawn the SRT-wrapped argv and accumulate the child result. */
function spawnSandboxed(
  wrapped: { argv: string[]; env: NodeJS.ProcessEnv },
  req: SandboxExecRequest,
): Promise<SandboxExecResult> {
  return new Promise((resolve) => {
    const child = spawn(wrapped.argv[0], wrapped.argv.slice(1), {
      cwd: req.command.cwd,
      env: req.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let lastFlushedLen = 0;

    const emitProgress = (chunk: string): void => {
      if (chunk.length > 0) req.onUpdate?.({ message: chunk });
    };

    child.stdout?.on("data", (b: Buffer) => {
      const chunk = b.toString();
      stdout += chunk;
      lastFlushedLen = stdout.length;
      emitProgress(chunk);
    });
    child.stderr?.on("data", (b: Buffer) => (stderr += b.toString()));

    let exitCode = 0;
    let closed = false;
    let stdoutEnded = !child.stdout;

    const checkDone = (): void => {
      if (closed && stdoutEnded) {
        if (stdout.length > lastFlushedLen) {
          emitProgress(stdout.slice(lastFlushedLen));
        }
        resolve({ exitCode, stdout, stderr, isolated: true });
      }
    };

    child.stdout?.on("end", () => {
      stdoutEnded = true;
      checkDone();
    });
    child.on("close", (code) => {
      exitCode = code ?? 0;
      closed = true;
      checkDone();
    });
    req.signal?.addEventListener("abort", () => child.kill("SIGTERM"));
  });
}

/** The subset of the SRT SandboxManager API this adapter consumes. */
export interface SrtSandboxManager {
  initialize(config: unknown, askCallback?: unknown, enableLogMonitor?: boolean): Promise<void>;
  isSandboxingEnabled(): boolean;
  wrapWithSandboxArgv(
    command: string,
    binShell?: string,
    customConfig?: { filesystem?: { allowRead?: string[]; allowWrite?: string[] } },
    abortSignal?: AbortSignal,
    cwd?: string,
  ): Promise<{ argv: string[]; env: NodeJS.ProcessEnv }>;
  cleanupAfterCommand(): Promise<void> | void;
}

/**
 * Factory: create the best available sandbox for the current platform.
 * Probes for binary presence and ASRT SDK availability. Returns
 * UncontainedSandbox with isolated:false when containment is unavailable.
 */
export async function createNativeProcessSandbox(): Promise<NativeProcessSandbox> {
  return AsrtSandbox.create();
}
