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
});
