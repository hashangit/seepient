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
    auditLog: process.env.SEEPIENT_AUDIT_LOG_PATH,
  };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.SEEPIENT_SECURITY_DIR;
  delete process.env.SEEPIENT_AUDIT_LOG_PATH;
  return {
    restore() {
      process.env.HOME = saved.home;
      process.env.USERPROFILE = saved.userProfile;
      if (saved.secDir === undefined) delete process.env.SEEPIENT_SECURITY_DIR;
      else process.env.SEEPIENT_SECURITY_DIR = saved.secDir;
      if (saved.auditLog === undefined) delete process.env.SEEPIENT_AUDIT_LOG_PATH;
      else process.env.SEEPIENT_AUDIT_LOG_PATH = saved.auditLog;
    },
  };
}

describe("027 review P1-3: read-only HOME zero-write", () => {
  it("core-only single+stateless constructs and completes a turn on a read-only $HOME", async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "readonly-home-"));
    const workDir = mkdtempSync(join(tmpdir(), "readonly-home-work-"));
    chmodSync(fakeHome, 0o555); // read-only: EACCES on any mkdir under it
    const saved = isolateAmbientPaths(fakeHome);

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
      saved.restore();
      chmodSync(fakeHome, 0o755);
      rmSync(fakeHome, { recursive: true, force: true });
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("review round-3 P1-1: a providers-record construction writes nothing ambient on a writable $HOME", async () => {
    const { createSeepient } = await import("../transport/sdk/seepient.js");
    const { MemoryCredentialStore } = await import("../domain/providers/credentials/memory-credential-store.js");
    const home = mkdtempSync(join(tmpdir(), "providers-home-"));
    const work = mkdtempSync(join(tmpdir(), "providers-work-"));
    const saved = isolateAmbientPaths(home);
    try {
      const credentials = new MemoryCredentialStore();
      await credentials.put("openai-main", { kind: "api_key", keyValue: "sk-test" } as never);
      // The core README's own quickstart shape. Pre-fix, the runtime bootstrap's
      // updateOverlay fired recordProviderAuditEvent, which wrote
      // $HOME/.seepient/audit.log in the same construction the tenancy notice
      // claimed wrote nothing.
      const agent = await createSeepient({
        stateless: true,
        tenancy: "single",
        skills: false,
        cwd: work,
        credentials,
        providers: {
          "my-openai": { adapter: "pi-ai", upstreamProvider: "test", credential: { kind: "seepient", id: "openai-main" } },
        },
        modelAssignments: { text: { standard: { providerAccount: "my-openai", model: "gpt-4.1-mini" } } },
      } as never);
      expect(existsSync(join(home, ".seepient"))).toBe(false);
      expect(readdirSync(home)).toEqual([]);
      await agent.close();
      expect(existsSync(join(home, ".seepient"))).toBe(false);
    } finally {
      saved.restore();
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
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
      const opts = { runtime, tenancy: "single", skills: false, tools: [echo], cwd: work1, approveTool: async () => true } as never;
      const res = (await askSeepient("use echo", opts as { stream?: false })) as { text: string };
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
      const opts2 = { runtime, tenancy: "single", skills: false, tools: [echo], cwd: work2, approveTool: async () => true } as never;
      const res = (await askSeepient("use echo", opts2 as { stream?: false })) as { text: string };
      expect(res.text).toBe("Done");
      expect(existsSync(join(roHome, ".seepient"))).toBe(false);
    } finally {
      saved2.restore();
      chmodSync(roHome, 0o755);
      rmSync(roHome, { recursive: true, force: true });
      rmSync(work2, { recursive: true, force: true });
    }
  });

  // v0.9.0 gate r1 (P2-c): the in-memory default gate now keys on the
  // registered ambient defaults, NOT the stateless conjunct — a single-mode
  // SESSIONFUL core construction (persist injected, no `stateless`) must
  // also resolve the in-memory store set and write nothing ambient. Pre-fix
  // it defaulted LocalAuditStore/LocalPolicyStore/PersistedCapabilityLedger,
  // and the action lifecycle's pre-dispatch + terminal audit events created
  // `$HOME/.seepient/security/{audit,caps}` on the first tool-bearing turn
  // (asserted on a WRITABLE home: on a read-only one the same writes fail
  // soft, so an exists check there cannot see the violation).
  it("gate r1 P2-c: single+sessionful (persist injected) writes nothing ambient", async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "readonly-sessionful-"));
    const workDir = mkdtempSync(join(tmpdir(), "readonly-sessionful-w-"));
    const saved = isolateAmbientPaths(fakeHome);

    try {
      const { createSeepient } = await import("../transport/sdk/seepient.js");
      const { trustedHostTool } = await import("../transport/sdk/custom-tools.js");
      const { createMockRuntime } = await import("../domain/__tests__/test-doubles.js");
      const { MemoryPersistenceBackend } = await import("../domain/sessions/session-store.js");

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
        // No `stateless` — the sessionful shape is the point of this gate.
        tenancy: "single",
        sessionId: "gate-r1-session",
        persist: new MemoryPersistenceBackend(),
        runtime: runtime as never,
        tools: [echo],
        cwd: workDir,
        skills: false,
        approveTool: async () => true,
      } as never);

      const res = await agent.chat("use echo");
      expect(res.text).toBe("turn complete");
      await agent.close(); // terminal events + outbox flush included

      // Zero ambient writes under the (writable) home; persistence is the
      // caller's injected backend, not the host disk.
      expect(existsSync(join(fakeHome, ".seepient"))).toBe(false);
      expect(readdirSync(fakeHome)).toEqual([]);
    } finally {
      saved.restore();
      rmSync(fakeHome, { recursive: true, force: true });
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
