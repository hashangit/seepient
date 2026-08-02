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
    // Session init ran once with a deny-all base config.
    expect(fakeManager.initialize).toHaveBeenCalledTimes(1);
    expect(fakeManager.initialize.mock.calls[0][0]).toEqual({
      network: { allowedDomains: [], deniedDomains: ["*"] },
      filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
    });
    // Per-exec roots mapped onto the SRT filesystem config.
    const wrapArgs = fakeManager.wrapWithSandboxArgv.mock.calls[0];
    expect(wrapArgs[2]).toEqual({ filesystem: { allowRead: ["/work"], allowWrite: ["/work"] } });
    // The sanitized env is baked into the wrapped command line (T207: the
    // child never sees ambient process env), shell-quoted safely.
    const commandLine = wrapArgs[0] as string;
    expect(commandLine).toContain("TEST_VAR='a b'\\''c'");
    expect(commandLine).toContain("'/bin/echo' 'adapter-ok'");
    // Cleanup runs after the command.
    expect(fakeManager.cleanupAfterCommand).toHaveBeenCalled();
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
