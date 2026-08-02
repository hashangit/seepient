import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNativeProcessSandbox } from "../../../vendors/sandbox-runtime/index.js";
import type { NativeProcessSandbox, SandboxExecResult } from "../../../vendors/sandbox-runtime/index.js";

/**
 * REAL containment negative canaries (review P0, release gate): against the
 * actual Seatbelt/Bubblewrap backend, a command approved for one directory
 * must NOT be able to read or write outside its roots, must NOT reach the
 * network, and MUST still run normal commands. Skips when the platform has
 * no containment backend (mirrors the NFR-004 real-primitive gate).
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
        `[canary] containment backend unavailable (${sandbox.probe.reason ?? "none"}) — skipping real canaries`,
      );
      return;
    }
    workspace = mkdtempSync(join(tmpdir(), "seepient-canary-ws-"));
    outsideSecret = join(tmpdir(), `seepient-canary-secret-${process.pid}.txt`);
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

  it("runs a normal command inside the workspace (system deps readable)", async () => {
    if (skip) return;
    const r = await run("echo canary-ok");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("canary-ok");
    expect(r.isolated).toBe(true);
  });

  it("denies reading a file outside the approved roots", async () => {
    if (skip) return;
    const r = await run(`cat ${outsideSecret}`);
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout).not.toContain("canary-secret-content-must-not-leak");
  });

  it("denies writing outside the approved roots", async () => {
    if (skip) return;
    const target = join(tmpdir(), `seepient-canary-write-${process.pid}.txt`);
    const r = await run(`touch ${target}`);
    expect(r.exitCode).not.toBe(0);
    expect(existsSync(target)).toBe(false);
  });

  it("allows reads and writes inside the approved workspace root", async () => {
    if (skip) return;
    const r = await run(`cat inside.txt`);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("inside-content");
    const w = await run(`touch inside-write.txt`);
    expect(w.exitCode).toBe(0);
    expect(existsSync(join(workspace, "inside-write.txt"))).toBe(true);
  });

  it("denies reads of protected credential paths even when the parent would be allowed", async () => {
    if (skip) return;
    const sshDir = join(process.env.HOME ?? "", ".ssh");
    if (!existsSync(sshDir)) return; // nothing to protect on this machine
    const r = await run(`ls ${sshDir}`);
    expect(r.exitCode).not.toBe(0);
  });

  it("blocks outbound network (deny-all egress)", async () => {
    if (skip) return;
    // curl ships with macOS; on Linux CI bwrap blocks via proxy/no-network.
    const r = await run(`curl -sS -m 8 https://example.com`);
    expect(r.exitCode).not.toBe(0);
  }, 30_000);

  it("git still works with non-secret user config (gitconfig allow)", async () => {
    if (skip) return;
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
