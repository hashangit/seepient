import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { createNativeProcessSandbox } from "../../../vendors/sandbox-runtime/index.js";
import type { NativeProcessSandbox, SandboxExecResult } from "../../../vendors/sandbox-runtime/index.js";

/**
 * REAL containment negative canaries (review P0, release gate): against the
 * actual Seatbelt/Bubblewrap backend, a command approved for one directory
 * must NOT be able to read or write outside its roots, must NOT reach the
 * network, and MUST still run normal commands. Backend-unavailable platforms
 * show these as SKIPPED (explicit platform gate), never as vacuous passes.
 *
 * Causality rules (review round 2): the outside secret lives OUTSIDE every
 * runtime dependency of both platforms (homedir, not tmpdir — /tmp and
 * /var/folders are runtime deps), the network canary uses a LOCAL listener
 * the test controls (no external connectivity involved), and every write
 * canary asserts FILESYSTEM STATE, not just exit codes.
 */
describe("containment negative canaries (review P0)", () => {
  let sandbox: NativeProcessSandbox;
  let workspace: string;
  let outsideSecret: string;
  let skip = false;

  beforeAll(async () => {
    sandbox = await createNativeProcessSandbox();
    if (!sandbox.probe.available || sandbox.probe.backend === "none") {
      skip = true;
      console.warn(
        `[canary] containment backend unavailable (${sandbox.probe.reason ?? "none"}) — canaries SKIPPED`,
      );
      return;
    }
    workspace = mkdtempSync(join(tmpdir(), "seepient-canary-ws-"));
    // OUTSIDE the runtime deps of both platforms: homedir (deps only cover
    // ~/.gitconfig* and ~/.config/git on macOS; nothing under ~ on Linux
    // except /root/.cache). tmpdir() would be INSIDE /tmp (/var/folders)
    // which is a runtime dependency — a secret there would defeat the test.
    outsideSecret = join(process.env.HOME ?? workspace, `.seepient-canary-outside-${process.pid}.txt`);
    writeFileSync(outsideSecret, "canary-secret-content-must-not-leak");
    writeFileSync(join(workspace, "inside.txt"), "inside-content");
  });

  afterAll(() => {
    if (workspace) rmSync(workspace, { recursive: true, force: true });
    if (outsideSecret) rmSync(outsideSecret, { force: true });
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

  it.runIf(!skip)("denies reading a file outside the approved roots", async () => {
    const r = await run(`cat ${outsideSecret}`);
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout).not.toContain("canary-secret-content-must-not-leak");
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
        process.env.HOME = realHome;
        process.env.SEEPIENT_SECURITY_DIR = realSecurityDir;
        rmSync(tempHome, { recursive: true, force: true });
      }
    },
  );

  it.runIf(!skip)(
    "blocks outbound network — deterministic local listener (no external connectivity)",
    async () => {
      // A listener WE control: if the sandbox allowed egress, the sandboxed
      // curl would reach it and return the banner. SRT's deny-all proxy must
      // stop it regardless of the machine's external connectivity.
      const banner = "canary-network-leak";
      const { port, close } = await new Promise<{ port: number; close: () => void }>((resolve) => {
        const server = createServer((socket) => socket.end(banner));
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
        expect(r.stdout).not.toContain(banner);
      } finally {
        close();
      }
    },
    30_000,
  );

  it.runIf(!skip)("git still works with non-secret user config (gitconfig allow)", async () => {
    // /usr/bin/git is an xcode-select shim on CLT-only Macs; its probe of
    // /var/select/developer_dir cannot be allowed through SRT's path
    // canonicalization (alias-form read is unmatchable — fails closed, not
    // a bypass). Use the resolved developer-tools binary when present.
    const cltGit = "/Library/Developer/CommandLineTools/usr/bin/git";
    const gitBin = existsSync(cltGit) ? cltGit : "git";
    const r = await run(`${gitBin} --version`);
    expect(r.exitCode).toBe(0);
  });
});
