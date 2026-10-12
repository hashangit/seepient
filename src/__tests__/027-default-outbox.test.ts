/**
 * Review round-2 P1-2 pin: the full package's DEFAULT SDK construction (no
 * injected auditStore) must run the composition-root audit plumbing — the
 * terminal-event outbox AND `recoverIndeterminateActions` crash recovery.
 * The round-1 repair narrowed `isLocalStore` to the injected case only;
 * default-constructed agents silently skipped recovery (the factory's
 * fallback outbox reloads+flushes pending events at construction, but the
 * indeterminate-action marking — T109c — lives only at the composition
 * root), so a crashed run's dispatched actions stayed indeterminate forever.
 *
 * Deterministic mechanics: seed the audit store with a `dispatched` event
 * that has no terminal successor (the crash signature) → default-construct
 * → construction-time recovery must append the `indeterminate` marker.
 * Pre-fix this pin fails: recovery never runs on the narrowed path.
 */
import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const CRASHED_ACTION_ID = "act-027-p12-crashed";

describe("027 review round-2 P1-2: default-construction audit plumbing", () => {
  it("default construction runs indeterminate-action crash recovery", async () => {
    const secDir = mkdtempSync(join(tmpdir(), "p12-audit-"));
    const work = mkdtempSync(join(tmpdir(), "p12-audit-work-"));
    const savedSec = process.env.SEEPIENT_SECURITY_DIR;
    process.env.SEEPIENT_SECURITY_DIR = secDir;

    try {
      // Seed the crash signature: a dispatched action with no terminal
      // successor (what a killed process leaves behind).
      const auditDir = join(secDir, "audit"); // SEEPIENT_SECURITY_DIR replaces the security root
      const wsDir = join(auditDir, "sdk-user");
      mkdirSync(wsDir, { recursive: true });
      const marker = createHash("sha256").update(`${CRASHED_ACTION_ID}|indeterminate|recovery`).digest("hex").slice(0, 16);
      const crashedLine = JSON.stringify({
        event: {
          eventId: "evt-crash-1",
          actionId: CRASHED_ACTION_ID,
          actionDigest: "digest-crash",
          principalId: "sdk-user",
          runId: "run-crash",
          state: "dispatched",
          timestamp: Date.now(),
          policyDigest: "digest-crash",
          backend: "local-native",
        },
        idempotencyKey: `${CRASHED_ACTION_ID}:dispatched`,
      });
      writeFileSync(join(wsDir, "events.ndjson"), crashedLine + "\n");

      // Default construction — NO injected auditStore.
      await import("../transport/sdk/full-registrations.js");
      const { createSeepient } = await import("../transport/sdk/seepient.js");
      const { createMockRuntime } = await import("../domain/__tests__/test-doubles.js");
      const agent = await createSeepient({
        tenancy: "single",
        runtime: createMockRuntime([{ content: "Done" }]) as never,
        skills: false,
        cwd: work,
      } as never);

      const events = readFileSync(join(wsDir, "events.ndjson"), "utf8");
      expect(
        events.includes(`"indeterminate"`) && events.includes(CRASHED_ACTION_ID),
        "construction-time crash recovery must mark the dispatched-without-terminal action indeterminate",
      ).toBe(true);
      await agent.close();
      expect(existsSync(join(work, "ok"))).toBe(false); // sanity: agent usable, env intact
    } finally {
      process.env.SEEPIENT_SECURITY_DIR = savedSec;
      rmSync(secDir, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });
});
