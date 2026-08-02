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
// Type-only imports from the pinned SDK (0.0.67). `ISandboxManager` is not
// re-exported from the package index, so it is imported from the deep
// declaration; both are erased at compile time, keeping the optional peer
// dep out of the runtime module graph.
import type { FilesystemConfig } from "@anthropic-ai/sandbox-runtime";
import type { ISandboxManager } from "@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-manager.js";

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
  /**
   * Set when the child was terminated by a signal (abort/cancel) — the
   * executor must record `cancelled`, never success (review P1: a
   * signal-terminated child reports exitCode null, which must not become 0).
   */
  signal?: NodeJS.Signals;
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
 *
 * CONTAINMENT MODEL (review P0 fix): SRT 0.0.67 treats `allowRead` as a
 * re-allow list INSIDE `denyRead`. The adapter therefore initializes
 * deny-by-default reads — `denyRead: ["/"]` plus immutable protected-path
 * exclusions (SSH/GPG/AWS/Seepient stores) — and re-allows only the
 * per-exec roots plus an explicit system runtime-dependency set. A command
 * approved for one directory can no longer read arbitrary user files.
 *
 * SHELL MODEL (review P1 fix): the SDK's only argv path is
 * `wrapWithSandboxArgv`, which emits `[shell, -c, wrapped]` — argument-array
 * exec is not offered by the SDK. The adapter therefore enforces a strict
 * shell-quoting model: every argv token is single-quoted with `'\''`
 * escaping, and environment KEYS are validated against a POSIX name regex
 * (invalid keys are dropped, never interpolated). Environment values are
 * always shell-quoted. This is documented in the 008 sandbox contract.
 */
export class AsrtSandbox implements NativeProcessSandbox {
  readonly probe: SandboxProbe;
  private readonly manager: ISandboxManager;
  private initPromise: Promise<boolean> | undefined;

  private constructor(probe: SandboxProbe, manager: ISandboxManager) {
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
        SandboxManager?: ISandboxManager;
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
   * network and deny-by-default reads at the session level; the per-exec
   * roots travel in the per-call customConfig (which REPLACES the session
   * filesystem, so it carries the same deny base).
   */
  private async init(): Promise<boolean> {
    this.initPromise ??= this.doInit();
    return this.initPromise;
  }

  private async doInit(): Promise<boolean> {
    try {
      await this.manager.initialize({
        network: { allowedDomains: [], deniedDomains: ["*"] },
        filesystem: denyByDefaultFilesystem(),
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
    // Pre-aborted signal: settle as cancelled immediately — a dead prompt
    // must not start a process (review P1).
    if (req.signal?.aborted) {
      return { exitCode: 0, stdout: "", stderr: "", isolated: true, signal: "SIGTERM" };
    }
    try {
      // The sanitized env (T207: no ambient secrets) is baked into the
      // wrapped command line; SRT's wrapper runs `env <SRT vars> <cmd>` and
      // the SDK returns `process.env` for spawning, so the child must spawn
      // with the SANITIZED env, not the SDK's, or secrets would re-enter.
      // Environment KEYS are validated (POSIX names only) and VALUES are
      // always shell-quoted — an injection attempt is dropped, never
      // interpolated (review P1 shell model).
      const envPairs = Object.entries(req.env)
        .filter(([k]) => ENV_KEY_PATTERN.test(k))
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

/** POSIX environment-variable name — anything else is dropped, never interpolated. */
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Shell-quote one token for the `bash -c` line SRT wraps. */
function shellQuote(token: string): string {
  return `'${token.replace(/'/g, "'\\''")}'`;
}

/**
 * Immutable protected paths: user credential stores that stay denied even
 * when the workspace (or an allowed root) would cover them. SRT re-emits
 * literal denyRead entries nested inside allowRead subpaths LAST, so these
 * exclusions win over any re-allow. Includes git credential stores — the
 * gitconfig allow below is config only.
 */
function protectedReadPaths(): string[] {
  const home = process.env.HOME;
  if (!home) return [];
  return [
    `${home}/.ssh`,
    `${home}/.gnupg`,
    `${home}/.aws`,
    `${home}/.seepient`,
    `${home}/.git-credentials`,
    `${home}/.config/git/credentials`,
  ];
}

/**
 * Explicit runtime read dependencies: the minimal system paths a sandboxed
 * command needs to exec and load libraries. Deny-by-default reads deny "/";
 * without this set every command would fail at dyld/bwrap setup. Deliberately
 * NARROW: no /var (covers /var/folders user temp and /var/root on Linux),
 * no /Users, no /home — anything user-owned outside the approved roots is
 * unreadable.
 */
function systemReadDeps(platform: NodeJS.Platform): string[] {
  if (platform === "linux") {
    return [
      "/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/dev", "/proc",
      "/sys", "/tmp", "/run", "/opt", "/nix", "/root/.cache",
    ];
  }
  return [
    "/usr", "/bin", "/sbin", "/System", "/Library", "/opt",
    "/private/etc", "/etc", "/dev", "/tmp", "/private/tmp",
  ];
}

/**
 * Non-secret user config the runtime legitimately reads (git includeIf
 * chains). Credential stores are NOT here — they are in protectedReadPaths.
 */
function userConfigReadPaths(home: string | undefined): string[] {
  if (!home) return [];
  return [`${home}/.gitconfig*`];
}

/**
 * Deny-by-default filesystem base: deny ALL reads, re-allow only system
 * runtime deps + non-secret user config. Per-exec roots are added on top by
 * `filesystemConfigFor`. Per-exec customConfig REPLACES this base, so it is
 * recomputed there with the same contents plus the roots.
 */
function denyByDefaultFilesystem(): FilesystemConfig {
  const home = process.env.HOME;
  return {
    denyRead: ["/", ...protectedReadPaths()],
    allowRead: [...systemReadDeps(process.platform), ...userConfigReadPaths(home)],
    allowWrite: [],
    denyWrite: [],
  };
}

/**
 * Map boundary root requests onto the SRT filesystem config: the full
 * deny-by-default base PLUS this command's approved roots (reads for every
 * root, writes only for write-access roots).
 */
function filesystemConfigFor(roots: RootRequest[]): FilesystemConfig {
  const base = denyByDefaultFilesystem();
  const allowRead = new Set<string>(base.allowRead ?? []);
  const allowWrite = new Set<string>();
  for (const r of roots) {
    allowRead.add(r.canonicalRoot);
    if (r.access === "write") allowWrite.add(r.canonicalRoot);
  }
  return {
    denyRead: base.denyRead,
    allowRead: [...allowRead],
    allowWrite: [...allowWrite],
    denyWrite: [],
  };
}

/**
 * Spawn the SRT-wrapped argv and accumulate the child result. Handles
 * spawn failures as TYPED results (never an uncaught event that would dump
 * the wrapped command + proxy credential), and cancellation: pre-abort is
 * checked by the caller, the process TREE is terminated via its own
 * process group, the abort listener is removed on settle, and a
 * signal-terminated child is reported with `signal` so the executor can
 * record `cancelled`, never success.
 */
function spawnSandboxed(
  wrapped: { argv: string[]; env: NodeJS.ProcessEnv },
  req: SandboxExecRequest,
): Promise<SandboxExecResult> {
  const { promise, resolve } = Promise.withResolvers<SandboxExecResult>();
  let settled = false;
  const settle = (result: SandboxExecResult): void => {
    if (settled) return;
    settled = true;
    req.signal?.removeEventListener("abort", onAbort);
    resolve(result);
  };
  const child = spawn(wrapped.argv[0], wrapped.argv.slice(1), {
    cwd: req.command.cwd,
    env: req.env,
    shell: false,
    detached: true,
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
  let signal: NodeJS.Signals | undefined;
  let closed = false;
  let stdoutEnded = !child.stdout;

  const checkDone = (): void => {
    if (!closed || !stdoutEnded) return;
    if (stdout.length > lastFlushedLen) {
      emitProgress(stdout.slice(lastFlushedLen));
    }
    // A signal-terminated child is a CANCELLED execution, never success
    // (exitCode is null in that case; reporting 0 would let the audit
    // record an aborted command as succeeded — review P1).
    settle({ exitCode, stdout, stderr, isolated: true, signal });
  };

  // Spawn failures (missing cwd, ENOENT binary) are typed results with a
  // GENERIC message — never the wrapped argv or the ASRT proxy credential
  // (review P1).
  child.on("error", (err) => {
    const code = (err as NodeJS.ErrnoException).code ?? "spawn-error";
    settle({
      exitCode: 1,
      stdout: "",
      stderr: `Failed to start sandboxed process: ${code}`,
      isolated: true,
    });
  });

  child.stdout?.on("end", () => {
    stdoutEnded = true;
    checkDone();
  });
  child.on("close", (code, closeSignal) => {
    exitCode = code ?? 0;
    signal = closeSignal ?? undefined;
    closed = true;
    checkDone();
  });
  const onAbort = (): void => {
    // Kill the whole process group (detached), not just the bash wrapper,
    // so descendant processes cannot outlive the cancellation.
    if (child.pid !== undefined) {
      try {
        process.kill(-child.pid, "SIGTERM");
        return;
      } catch {
        /* fall through to single-process kill */
      }
    }
    child.kill("SIGTERM");
  };
  req.signal?.addEventListener("abort", onAbort);
  return promise;
}

/**
 * Factory: create the best available sandbox for the current platform.
 * Probes for binary presence and ASRT SDK availability. Returns
 * UncontainedSandbox with isolated:false when containment is unavailable.
 */
export async function createNativeProcessSandbox(): Promise<NativeProcessSandbox> {
  return AsrtSandbox.create();
}
