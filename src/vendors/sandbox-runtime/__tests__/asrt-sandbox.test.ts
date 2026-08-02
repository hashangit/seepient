import { describe, it, expect, vi, beforeEach } from "vitest";

// Deterministic platform probe: seatbelt available, regardless of host.
vi.mock("../index.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../index.js")>();
  return {
    ...mod,
    probeSandbox: async () => ({
      available: true,
      platform: "darwin",
      backend: "seatbelt",
    }),
  };
});

const fakeManager: {
  initialize: ReturnType<typeof vi.fn>;
  isSandboxingEnabled: ReturnType<typeof vi.fn>;
  wrapWithSandboxArgv: ReturnType<typeof vi.fn>;
  cleanupAfterCommand: ReturnType<typeof vi.fn>;
} = {
  initialize: vi.fn().mockResolvedValue(undefined),
  isSandboxingEnabled: vi.fn().mockReturnValue(true),
  wrapWithSandboxArgv: vi.fn().mockResolvedValue({
    argv: ["/bin/sh", "-c", "echo adapter-ok"],
    env: {},
  }),
  cleanupAfterCommand: vi.fn().mockResolvedValue(undefined),
};

vi.mock("@anthropic-ai/sandbox-runtime", () => ({
  SandboxManager: fakeManager,
}));

import { UncontainedSandbox, createNativeProcessSandbox } from "../index.js";

const execRequest = {
  command: { executable: "/bin/echo", argv: ["adapter-ok"], cwd: "/tmp" },
  roots: [{ access: "write" as const, canonicalRoot: "/work" }],
  env: { TEST_VAR: "a b'c" },
  signal: undefined,
};

describe("AsrtSandbox (SDK 0.0.67 SandboxManager adapter)", () => {
  beforeEach(() => {
    fakeManager.initialize.mockClear();
    fakeManager.isSandboxingEnabled.mockClear();
    fakeManager.wrapWithSandboxArgv.mockClear();
    fakeManager.cleanupAfterCommand.mockClear();
  });

  it("exec wraps the sanitized command line and runs it under the sandbox", async () => {
    const sandbox = await createNativeProcessSandbox();
    expect(sandbox.probe.backend).toBe("seatbelt");
    const result = await sandbox.exec(execRequest);
    expect(result.isolated).toBe(true);
    expect(result.stdout).toContain("adapter-ok");
    // Session init ran once with a DENY-BY-DEFAULT base config: deny "/"
    // reads, re-allow only system runtime deps + non-secret user config
    // (review P0 — allowRead alone re-allows inside denyRead, so an empty
    // denyRead used to mean allow-all reads).
    expect(fakeManager.initialize).toHaveBeenCalledTimes(1);
    const initConfig = fakeManager.initialize.mock.calls[0][0] as {
      network: { allowedDomains: string[]; deniedDomains: string[] };
      filesystem: { denyRead: string[]; allowRead?: string[]; allowWrite: string[]; denyWrite: string[] };
    };
    expect(initConfig.network).toEqual({ allowedDomains: [], deniedDomains: ["*"] });
    expect(initConfig.filesystem.denyRead[0]).toBe("/");
    expect(initConfig.filesystem.denyRead).toContain(`${process.env.HOME}/.ssh`);
    expect(initConfig.filesystem.denyRead).toContain(`${process.env.HOME}/.seepient`);
    expect(initConfig.filesystem.allowRead).toContain("/usr");
    expect(initConfig.filesystem.allowWrite).toEqual([]);
    // Per-exec customConfig REPLACES the session filesystem, so it carries
    // the SAME deny-by-default base plus this command's approved roots.
    const wrapArgs = fakeManager.wrapWithSandboxArgv.mock.calls[0];
    const perExecFs = wrapArgs[2] as {
      filesystem: { denyRead: string[]; allowRead: string[]; allowWrite: string[]; denyWrite: string[] };
    };
    expect(perExecFs.filesystem.denyRead[0]).toBe("/");
    expect(perExecFs.filesystem.allowRead).toContain("/work");
    expect(perExecFs.filesystem.allowWrite).toEqual(["/work"]);
    // The sanitized env is baked into the wrapped command line (T207: the
    // child never sees ambient process env), shell-quoted safely.
    const commandLine = wrapArgs[0] as string;
    expect(commandLine).toContain("TEST_VAR='a b'\\''c'");
    expect(commandLine).toContain("'/bin/echo' 'adapter-ok'");
    // Cleanup runs after the command.
    expect(fakeManager.cleanupAfterCommand).toHaveBeenCalled();
  });

  it("drops environment keys that are not POSIX names — never interpolates (review P1 shell model)", async () => {
    const sandbox = await createNativeProcessSandbox();
    const evil = "X=1; rm -rf /tmp/owned";
    await sandbox.exec({
      ...execRequest,
      env: { GOOD_KEY: "ok", [evil]: "value" },
    });
    const commandLine = fakeManager.wrapWithSandboxArgv.mock.calls[0][0] as string;
    expect(commandLine).toContain("GOOD_KEY='ok'");
    // The injection-shaped key never appears in the wrapped command.
    expect(commandLine).not.toContain("rm -rf");
    expect(commandLine).not.toContain(evil);
  });

  it("spawn failures are typed results without the wrapped command or credentials (review P1)", async () => {
    fakeManager.wrapWithSandboxArgv.mockResolvedValueOnce({
      argv: ["/nonexistent-wrapper-binary", "-c", "env ASRT_PROXY_TOKEN=sekrit true"],
      env: {},
    });
    const sandbox = await createNativeProcessSandbox();
    const result = await sandbox.exec(execRequest);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Failed to start sandboxed process");
    // No proxy credential or wrapped argv in the surfaced error.
    expect(result.stderr).not.toContain("sekrit");
    expect(result.stderr).not.toContain("ASRT_PROXY_TOKEN");
  });

  it("a pre-aborted signal settles immediately as cancelled (review P1)", async () => {
    const sandbox = await createNativeProcessSandbox();
    const controller = new AbortController();
    controller.abort();
    const result = await sandbox.exec({ ...execRequest, signal: controller.signal });
    expect(result.signal).toBeDefined();
    expect(fakeManager.wrapWithSandboxArgv).not.toHaveBeenCalled();
  });

  it("fails closed to UncontainedSandbox when session initialize fails", async () => {
    fakeManager.initialize.mockRejectedValueOnce(new Error("deps missing"));
    const sandbox = await createNativeProcessSandbox();
    expect(sandbox).toBeInstanceOf(UncontainedSandbox);
    expect(sandbox.probe.backend).toBe("none");
  });

  it("fails closed when sandboxing is not enabled after init", async () => {
    fakeManager.isSandboxingEnabled.mockReturnValueOnce(false);
    const sandbox = await createNativeProcessSandbox();
    expect(sandbox).toBeInstanceOf(UncontainedSandbox);
    expect(sandbox.probe.backend).toBe("none");
  });
});
