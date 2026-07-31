import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createServer } from "../index.js";

/**
 * T109c: the HTTP server MUST run audit outbox recovery on startup so a
 * `dispatched` action that crashed before recording a terminal state is marked
 * `indeterminate` (never silently re-executed, never left as a dangling
 * success). This test plants such a record and asserts the server's recovery
 * pass actually closed it.
 *
 * This is a regression guard: a prior iteration imported `LocalAuditStore` from
 * the wrong module, so the import resolved to `undefined`, the constructor
 * threw, and the surrounding try/catch swallowed the error — `createServer()`
 * still resolved but recovery never ran. The old test only asserted
 * `createServer()` resolved, so it could not detect that. This one asserts the
 * recovery *effect*.
 */
describe("HTTP server audit recovery initialization (T109c)", () => {
  it("marks a crashed dispatched action as indeterminate on startup", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "http-audit-test-"));
    const originalCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      // The LocalAuditStore routes by principalId (see audit-recorder.ts): with
      // `root: process.cwd()` the events file lives at <cwd>/<principalId>/
      // events.ndjson. Plant a `dispatched` record with NO matching terminal so
      // recovery must close it.
      const principalId = "recovery-test-principal";
      const actionId = "action-crashed-1";
      const auditDir = path.join(tmpDir, principalId);
      await fs.mkdir(auditDir, { recursive: true });
      const planted = {
        event: {
          eventId: "ev-1",
          actionId,
          actionDigest: "digest-1",
          principalId,
          runId: "run-1",
          state: "dispatched",
          timestamp: Date.now(),
          policyDigest: "policy-1",
          backend: "local-native",
        },
        idempotencyKey: `${actionId}:dispatched`,
      };
      await fs.writeFile(
        path.join(auditDir, "events.ndjson"),
        JSON.stringify(planted) + "\n",
        "utf8",
      );

      // Startup triggers reload + flush + recoverIndeterminateActions.
      const server = await createServer({ permissionPipeline: true });
      expect(server).toBeDefined();
      server.close();

      // The recovery pass MUST have appended an `indeterminate` marker for the
      // crashed action. This assertion fails if recovery did not run (e.g. the
      // old broken import that threw inside try/catch).
      const after = await fs.readFile(path.join(auditDir, "events.ndjson"), "utf8");
      const lines = after.split("\n").filter((l) => l.trim().length > 0);
      const states = lines.map((l) => {
        try {
          return (JSON.parse(l).event?.state) as string | undefined;
        } catch {
          return undefined;
        }
      });
      expect(states).toContain("dispatched");
      expect(states).toContain("indeterminate");
    } finally {
      process.chdir(originalCwd);
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});

/**
 * FR-017/FR-018 (frozen R9.1 scope): server-side model-authored effect
 * execution is DISABLED. The control plane must never run effects in-process —
 * not behind a localhost bind, not behind a fallback flag, since a loopback
 * server can sit behind a reverse proxy and serve many users. Any of these
 * flags therefore refuses startup; without them the server starts in
 * effect-free mode (every effectful action denied as backend-unsupported).
 */
describe("HTTP server effect execution is disabled (frozen R9.1 scope)", () => {
  const flagsCases: Array<[string, string, string]> = [
    ["SEEPIENT_WORKER_SCHEDULER=1", "SEEPIENT_WORKER_SCHEDULER", "1"],
    ["SEEPIENT_WORKER_SCHEDULER_ENDPOINT set", "SEEPIENT_WORKER_SCHEDULER_ENDPOINT", "http://localhost:7338"],
    ["SEEPIENT_ALLOW_LOCAL_FALLBACK=1", "SEEPIENT_ALLOW_LOCAL_FALLBACK", "1"],
  ];
  for (const [label, flag, value] of flagsCases) {
    it(`refuses to start when ${label}`, async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "http-sched-test-"));
      const originalCwd = process.cwd();
      const original = process.env[flag];
      process.chdir(tmpDir);
      process.env[flag] = value;
      try {
        // Even binding to loopback must not allow in-process effects.
        await expect(createServer({ permissionPipeline: true, host: "127.0.0.1" })).rejects.toThrow(/disabled in this release/);
      } finally {
        process.chdir(originalCwd);
        if (original === undefined) delete process.env[flag];
        else process.env[flag] = original;
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      }
    });
  }

  it("starts in effect-free mode when no effect-execution flag is set", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "http-sched-test-"));
    const originalCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      const server = await createServer({ permissionPipeline: true });
      expect(server).toBeDefined();
      server.close();
    } finally {
      process.chdir(originalCwd);
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
