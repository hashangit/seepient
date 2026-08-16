import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { execFileSync } from "node:child_process";
import { createNativeProcessSandbox } from "../../../vendors/sandbox-runtime/index.js";
import type { NativeProcessSandbox, SandboxExecResult } from "../../../vendors/sandbox-runtime/index.js";

/**
 * REAL containment negative canaries (review P0, release gate): against the
 * actual Seatbelt/Bubblewrap backend, a command approved for one directory
 * must NOT be able to read or write outside its roots, must NOT reach the
 * network, and MUST still run normal commands.
 *
 * Causality rules (review rounds 2-3): the outside secret lives OUTSIDE every
 * runtime dependency of both platforms (homedir, not tmpdir — /tmp is not a
 * runtime dep anymore), the network canary asserts the local listener was
 * NEVER contacted, and every write canary asserts FILESYSTEM STATE.
 *
 * The backend probe runs at MODULE LOAD (top-level await), BEFORE test
 * registration, so `it.runIf(!skip)` is correct — backend-unavailable
 * platforms show explicit SKIPPED gates, never vacuous passes (P1 fix).
 */
const probe = await createNativeProcessSandbox();
const skip = !probe.probe.available || probe.probe.backend === "none";
if (skip) {
  console.warn(
    `[canary] containment backend unavailable (${probe.probe.reason ?? "none"}) — canaries SKIPPED`,
  );
}

describe("containment negative canaries (review P0)", () => {
  let sandbox: NativeProcessSandbox;
  let workspace: string;
  let outsideSecret: string;
  let tmpSecret: string;

  beforeAll(async () => {
    sandbox = await createNativeProcessSandbox();
    workspace = mkdtempSync(join(tmpdir(), "seepient-canary-ws-"));
    // OUTSIDE the runtime deps of both platforms: homedir (deps only cover
    // ~/.gitconfig* on macOS; nothing under ~ on Linux except /root/.cache).
    outsideSecret = join(process.env.HOME ?? workspace, `.seepient-canary-outside-${process.pid}.txt`);
    writeFileSync(outsideSecret, "canary-secret-content-must-not-leak");
    // A GLOBAL-TEMP secret: /tmp must NOT be readable without approval
    // (review round 3 P0 — the old allowlists exposed all of /tmp).
    tmpSecret = join(tmpdir(), `.seepient-canary-tmp-${process.pid}.txt`);
    writeFileSync(tmpSecret, "tmp-secret-must-not-leak");
    writeFileSync(join(workspace, "inside.txt"), "inside-content");
    const cltGit = "/Library/Developer/CommandLineTools/usr/bin/git";
    const gitBin = existsSync(cltGit) ? cltGit : "git";
    execFileSync(gitBin, ["init", "-q", workspace]);
  });

  afterAll(() => {
    if (workspace) rmSync(workspace, { recursive: true, force: true });
    if (outsideSecret) rmSync(outsideSecret, { force: true });
    if (tmpSecret) rmSync(tmpSecret, { force: true });
  });

  const run = async (command: string): Promise<SandboxExecResult> => {
    const parts = command.split(" ");
    return sandbox.exec({
      command: { executable: parts[0], argv: parts.slice(1), cwd: workspace },
      roots: [
        { access: "read", canonicalRoot: workspace },
        { access: "write", canonicalRoot: workspace },
      ],
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: process.env.HOME ?? workspace },
    });
  };

  it.runIf(!skip)("runs a normal command inside the workspace (system deps readable)", async () => {
    const r = await run("echo canary-ok");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("canary-ok");
    expect(r.isolated).toBe(true);
  });

  it.runIf(!skip)("sandboxed shell spawns with NO dyld select-sh error (macOS exec shim readable)", async () => {
    // macOS resolves a spawned shell through /private/var/select/sh (arch
    // selection shim). If it is not in the read allow list, every sandboxed
    // command run through a shell prints "Error opening
    // /private/var/select/sh: Operation not permitted" to stderr — exit
    // code stays 0 via the /bin/sh fallback, so stdout-only assertions miss
    // it. This canary asserts a shell's stderr is completely clean.
    const r = await sandbox.exec({
      command: { executable: "/bin/sh", argv: ["-c", "echo shell-ok"], cwd: workspace },
      roots: [
        { access: "read", canonicalRoot: workspace },
        { access: "write", canonicalRoot: workspace },
      ],
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: process.env.HOME ?? workspace },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("shell-ok");
    expect(r.stderr).toBe("");
  });

  it.runIf(!skip)("denies reading a file outside the approved roots", async () => {
    const r = await run(`cat ${outsideSecret}`);
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout).not.toContain("canary-secret-content-must-not-leak");
  });

  it.runIf(!skip)("denies reading unapproved GLOBAL TEMP files (review round 3 P0)", async () => {
    const r = await run(`cat ${tmpSecret}`);
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout).not.toContain("tmp-secret-must-not-leak");
  });

  it.runIf(!skip)("the per-exec scratch directory is usable by the command", async () => {
    // The adapter provisions a per-action scratch and sets TMPDIR to it;
    // a command that writes and re-reads its own scratch must succeed.
    // Use a REAL shell (/bin/sh is an xcode-select shim on CLT-only Macs).
    const bash = existsSync("/opt/homebrew/bin/bash") ? "/opt/homebrew/bin/bash" : "/bin/bash";
    const parts = bash.split(" ");
    // Simulate the PRODUCTION sanitized environment, which retains an
    // ambient TMPDIR: the scratch assignment must WIN over it (round 4 P1).
    const ambientTmp = join(tmpdir(), "ambient-tmp-dir");
    const r = await sandbox.exec({
      command: {
        executable: parts[0],
        argv: ["-c", "echo scratch-ok > $TMPDIR/s.txt && cat $TMPDIR/s.txt && printf 'TMPDIR=%s' \"$TMPDIR\""],
        cwd: workspace,
      },
      roots: [
        { access: "read", canonicalRoot: workspace },
        { access: "write", canonicalRoot: workspace },
      ],
      env: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        HOME: process.env.HOME ?? workspace,
        TMPDIR: ambientTmp,
      },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("scratch-ok");
    // The child saw the PRIVATE scratch, not the ambient temp dir.
    expect(r.stdout).toContain("TMPDIR=");
    expect(r.stdout).toContain("seepient-scratch-");
    expect(r.stdout).not.toContain("ambient-tmp-dir");
  });

  it.runIf(!skip)("denies writing outside the approved roots (filesystem state)", async () => {
    const target = join(process.env.HOME ?? workspace, `.seepient-canary-write-${process.pid}.txt`);
    const r = await run(`touch ${target}`);
    expect(r.exitCode).not.toBe(0);
    expect(existsSync(target)).toBe(false);
  });

  it.runIf(!skip)("allows reads and writes inside the approved workspace root", async () => {
    const r = await run(`cat inside.txt`);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("inside-content");
    const w = await run(`touch inside-write.txt`);
    expect(w.exitCode).toBe(0);
    expect(existsSync(join(workspace, "inside-write.txt"))).toBe(true);
  });

  it.runIf(!skip)("denies reads of protected credential paths even when the parent would be allowed", async () => {
    const sshDir = join(process.env.HOME ?? "", ".ssh");
    if (!existsSync(sshDir)) return; // nothing to protect on this machine
    const r = await run(`ls ${sshDir}`);
    expect(r.exitCode).not.toBe(0);
  });

  it.runIf(!skip)("denies reads of the SEEPIENT_SECURITY_DIR override (review round 3 P0)", async () => {
    const realHome = process.env.HOME;
    const realSecurityDir = process.env.SEEPIENT_SECURITY_DIR;
    // The reviewer's scenario: the override store lives under an APPROVED
    // ANCESTOR root (the real home); the store itself must stay unreadable.
    const overrideRoot = join(realHome ?? "/tmp", ".seepient-canary-secdir-3", `${process.pid}`);
    const storeDir = join(overrideRoot, "policies");
    mkdirSync(storeDir, { recursive: true });
    writeFileSync(join(storeDir, "policy.json"), '{"secret":true}');
    try {
      process.env.SEEPIENT_SECURITY_DIR = overrideRoot;
      const r = await sandbox.exec({
        command: { executable: "/bin/cat", argv: [join(storeDir, "policy.json")], cwd: realHome ?? "/tmp" },
        roots: [{ access: "read", canonicalRoot: realHome ?? "/tmp" }],
        env: { PATH: "/usr/bin:/bin", HOME: realHome ?? "/tmp" },
      });
      expect(r.exitCode).not.toBe(0);
      expect(r.stdout).not.toContain("secret");
    } finally {
      if (realSecurityDir === undefined) delete process.env.SEEPIENT_SECURITY_DIR;
      else process.env.SEEPIENT_SECURITY_DIR = realSecurityDir;
      if (realHome === undefined) delete process.env.HOME;
      else process.env.HOME = realHome;
      rmSync(overrideRoot, { recursive: true, force: true });
    }
  });

  it.runIf(!skip)(
    "denies WRITES to protected stores even when an ANCESTOR root is approved (P0 review fix)",
    async () => {
      const realHome = process.env.HOME;
      const realSecurityDir = process.env.SEEPIENT_SECURITY_DIR;
      // Disposable home under the REAL home (a non-aliased path): SRT
      // canonicalizes allow paths, and /var -> /private/var aliases can
      // never match (the same limitation that breaks the xcode-select
      // shim). tmpdir() would put this under /var/folders and defeat the
      // control write.
      const tempHome = join(realHome ?? "/tmp", `.seepient-canary-home-${process.pid}`);
      const storeDir = join(tempHome, ".seepient", "security", "policies");
      // ALSO set the env-override store location (the reviewer's repro):
      // with SEEPIENT_SECURITY_DIR set, ~/.seepient must STILL be denied.
      const envStoreDir = join(tempHome, ".env-sec-dir", "policies");
      mkdirSync(storeDir, { recursive: true });
      mkdirSync(envStoreDir, { recursive: true });
      writeFileSync(join(storeDir, "canary-policy.json"), "{}");
      writeFileSync(join(envStoreDir, "canary-policy.json"), "{}");
      try {
        process.env.HOME = tempHome;
        process.env.SEEPIENT_SECURITY_DIR = join(tempHome, ".env-sec-dir");
        const attack = await sandbox.exec({
          command: { executable: "/usr/bin/touch", argv: [join(storeDir, "pwn.txt")], cwd: tempHome },
          roots: [
            { access: "read", canonicalRoot: tempHome },
            { access: "write", canonicalRoot: tempHome },
          ],
          env: { PATH: "/usr/bin:/bin", HOME: tempHome },
        });
        expect(attack.exitCode).not.toBe(0);
        // Filesystem state, not just the exit code (the reviewer's repro
        // created the file despite a nonzero exit).
        expect(existsSync(join(storeDir, "pwn.txt"))).toBe(false);
        // The env-override store is equally protected.
        const envAttack = await sandbox.exec({
          command: { executable: "/usr/bin/touch", argv: [join(envStoreDir, "pwn.txt")], cwd: tempHome },
          roots: [
            { access: "read", canonicalRoot: tempHome },
            { access: "write", canonicalRoot: tempHome },
          ],
          env: { PATH: "/usr/bin:/bin", HOME: tempHome },
        });
        expect(envAttack.exitCode).not.toBe(0);
        expect(existsSync(join(envStoreDir, "pwn.txt"))).toBe(false);
        // A normal write under the same approved ancestor root still works.
        const ok = await sandbox.exec({
          command: { executable: "/usr/bin/touch", argv: [join(tempHome, "ok.txt")], cwd: tempHome },
          roots: [
            { access: "read", canonicalRoot: tempHome },
            { access: "write", canonicalRoot: tempHome },
          ],
          env: { PATH: "/usr/bin:/bin", HOME: tempHome },
        });
        expect(ok.exitCode).toBe(0);
        expect(existsSync(join(tempHome, "ok.txt"))).toBe(true);
      } finally {
        if (realSecurityDir === undefined) delete process.env.SEEPIENT_SECURITY_DIR;
        else process.env.SEEPIENT_SECURITY_DIR = realSecurityDir;
        if (realHome === undefined) delete process.env.HOME;
        else process.env.HOME = realHome;
        rmSync(tempHome, { recursive: true, force: true });
      }
    },
  );

  it.runIf(!skip)(
    "blocks outbound network — deterministic local listener (no external connectivity)",
    async () => {
      // A listener WE control: if the sandbox allowed egress, the sandboxed
      // curl would reach it. SRT's deny-all proxy must stop it regardless of
      // the machine's external connectivity — and we assert the server was
      // NEVER contacted (not just that curl exited nonzero, which an HTTP
      // parse error could also satisfy — review round 3 P1).
      let contacted = false;
      const { port, close } = await new Promise<{ port: number; close: () => void }>((resolve) => {
        const server = createServer((socket) => {
          contacted = true;
          socket.end("canary-network-leak");
        });
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          resolve({
            port: typeof address === "object" && address ? address.port : 0,
            close: () => server.close(),
          });
        });
      });
      try {
        const r = await run(`curl -sS -m 8 http://127.0.0.1:${port}/`);
        expect(r.exitCode).not.toBe(0);
        expect(contacted).toBe(false);
      } finally {
        close();
      }
    },
    30_000,
  );

  it.runIf(!skip)("git status works through the same shell path used by tool execution", async () => {
    // /usr/bin/git is an xcode-select shim on CLT-only Macs. Production puts
    // the resolved CLT directory first only when that shim would otherwise be
    // selected; exercise the same /bin/sh -c path the shell analyzer uses.
    const cltGit = "/Library/Developer/CommandLineTools/usr/bin/git";
    const path = existsSync(cltGit)
      ? `/Library/Developer/CommandLineTools/usr/bin:/usr/bin:/bin:/usr/sbin:/sbin`
      : "/usr/bin:/bin:/usr/sbin:/sbin";
    const r = await sandbox.exec({
      command: { executable: "/bin/sh", argv: ["-c", "git -c core.excludesFile='' status --short"], cwd: workspace },
      roots: [
        { access: "read", canonicalRoot: workspace },
        { access: "write", canonicalRoot: workspace },
      ],
      env: {
        PATH: path,
        HOME: workspace,
        XDG_CONFIG_HOME: workspace,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe("");
  });
});
