/**
 * Spec 027 review P1-3: the serverless persona's red gate.
 *
 * A core-only single+stateless construction + turn must succeed on a
 * READ-ONLY $HOME (the Lambda condition) and write nothing under it.
 * Pre-fix, construction died `EACCES: mkdir ~/.seepient` via the ambient
 * LocalAuditStore/LocalPolicyStore/PersistedCapabilityLedger defaults and
 * the provider-audit log write.
 *
 * This file stays registration-free (no full-registrations import) — it
 * observes the CORE defaults.
 */
import { describe, it, expect } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Under vitest, src/test-setup.ts redirects SEEPIENT_SECURITY_DIR to a temp
 * dir — which is exactly why the round-1 gate could not see the askSeepient
 * ambient writes (review round-2 P1-1). These gates save/clear that env so
 * the REAL ambient path (homedir/.seepient) is exercised.
 */
function isolateAmbientPaths(home: string): { restore(): void } {
  const saved = {
    home: process.env.HOME,
    userProfile: process.env.USERPROFILE,
    secDir: process.env.SEEPIENT_SECURITY_DIR,
  };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.SEEPIENT_SECURITY_DIR;
  return {
    restore() {
      process.env.HOME = saved.home;
      process.env.USERPROFILE = saved.userProfile;
      if (saved.secDir === undefined) delete process.env.SEEPIENT_SECURITY_DIR;
      else process.env.SEEPIENT_SECURITY_DIR = saved.secDir;
    },
  };
}

const MOCK_RUNTIME = async () => {
  const { createMockRuntime } = await import("../domain/__tests__/test-doubles.js");
  return createMockRuntime([
    { toolCalls: [{ id: "tc1", name: "echo", args: { text: "hi" } }] },
    { content: "turn complete" },
  ]);
};

const ECHO_TOOL = async () => {
  const { trustedHostTool } = await import("../transport/sdk/custom-tools.js");
  return trustedHostTool({
    definition: {
      type: "function",
      function: {
        name: "echo",
        description: "echoes",
        parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      },
    },
    execute: async (args: { text: string }) => `echo:${args.text}`,
  } as never);
};

describe("027 review P1-3: read-only HOME zero-write", () => {
  it("core-only single+stateless constructs and completes a turn on a read-only $HOME", async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "readonly-home-"));
    const workDir = mkdtempSync(join(tmpdir(), "readonly-home-work-"));
    chmodSync(fakeHome, 0o555); // read-only: EACCES on any mkdir under it
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;

    try {
      const { createSeepient } = await import("../transport/sdk/seepient.js");
      const { trustedHostTool } = await import("../transport/sdk/custom-tools.js");
      const { createMockRuntime } = await import("../domain/__tests__/test-doubles.js");

      const echo = trustedHostTool({
        definition: {
          type: "function",
          function: {
            name: "echo",
            description: "echoes",
            parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
          },
        },
        execute: async (args: { text: string }) => `echo:${args.text}`,
      } as never);

      const runtime = createMockRuntime([
        { toolCalls: [{ id: "tc1", name: "echo", args: { text: "hi" } }] },
        { content: "turn complete" },
      ]);

      const agent = await createSeepient({
        stateless: true,
        tenancy: "single",
        runtime: runtime as never,
        tools: [echo],
        cwd: workDir,
        skills: false,
        approveTool: async () => true,
      } as never);

      const res = await agent.chat("use echo");
      expect(res.text).toBe("turn complete");
      expect(res.usage?.estimateMode).toBeDefined();

      // Zero ambient writes under the (read-only) home.
      expect(existsSync(join(fakeHome, ".seepient"))).toBe(false);
      expect(readdirSync(fakeHome)).toEqual([]);
    } finally {
      process.env.HOME = prevHome;
      process.env.USERPROFILE = prevUserProfile;
      chmodSync(fakeHome, 0o755);
      rmSync(fakeHome, { recursive: true, force: true });
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("review round-2 P1-1: a core-only askSeepient one-shot also writes nothing (writable + read-only HOME)", async () => {
    const { askSeepient } = await import("../transport/sdk/ask.js");
    const { trustedHostTool } = await import("../transport/sdk/custom-tools.js");
    const { createMockRuntime } = await import("../domain/__tests__/test-doubles.js");
    const echo = await trustedHostTool({
      definition: {
        type: "function",
        function: {
          name: "echo",
          description: "echoes",
          parameters: { type: "object", properties: {}, required: [] },
        },
      },
      execute: async () => "ok",
    } as never);
    const runtime = createMockRuntime([
      { toolCalls: [{ id: "tc1", name: "echo", args: {} }] },
      { content: "Done" },
    ]) as never;

    // Writable HOME: the one-shot must not write ambient state either.
    const writableHome = mkdtempSync(join(tmpdir(), "readonly-ask-w-"));
    const work1 = mkdtempSync(join(tmpdir(), "readonly-ask-w1-"));
    const saved = isolateAmbientPaths(writableHome);
    try {
      const res = await askSeepient("use echo", {
        runtime, tenancy: "single", skills: false, tools: [echo],
        cwd: work1, approveTool: async () => true,
      } as never);
      expect(res.text).toBe("Done");
      expect(existsSync(join(writableHome, ".seepient"))).toBe(false);
    } finally {
      saved.restore();
      rmSync(writableHome, { recursive: true, force: true });
      rmSync(work1, { recursive: true, force: true });
    }

    // Read-only HOME: no crash, no silent ambient attempts.
    const roHome = mkdtempSync(join(tmpdir(), "readonly-ask-ro-"));
    const work2 = mkdtempSync(join(tmpdir(), "readonly-ask-w2-"));
    chmodSync(roHome, 0o555);
    const saved2 = isolateAmbientPaths(roHome);
    try {
      const res = await askSeepient("use echo", {
        runtime, tenancy: "single", skills: false, tools: [echo],
        cwd: work2, approveTool: async () => true,
      } as never);
      expect(res.text).toBe("Done");
      expect(existsSync(join(roHome, ".seepient"))).toBe(false);
    } finally {
      saved2.restore();
      chmodSync(roHome, 0o755);
      rmSync(roHome, { recursive: true, force: true });
      rmSync(work2, { recursive: true, force: true });
    }
  });
});
