/**
 * US0 red gates (022-5-WO1 T003/T004): availability on the read/convert
 * plane. htmlToText must be linear-time on adversarial input (today the
 * tag-strip regex is quadratic: ~25 s at 256 KiB); the commit-files
 * old-content open must observe the abort signal and non-blocking open
 * (today a FIFO destination wedges the execute promise forever).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, realpathSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { htmlToText, CommitFilesExecutor } from "../executors.js";
import type { PreparedToolAction } from "../../../foundations/contracts/prepared-action.js";
import type { CapabilityEnvelope } from "../../../foundations/contracts/permission-policy.js";

describe("htmlToText adversarial wall clock (022-5-WO1 T003)", () => {
  it("converts 256 KiB of angle brackets in under 2 seconds", () => {
    const input = "<".repeat(256 * 1024);
    const started = Date.now();
    const out = htmlToText(input);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(2000);
    // Bounded single-space form: every bracket collapses, nothing repeats.
    expect(out.length).toBeLessThan(input.length);
    expect(out).not.toMatch(/ {2}/);
  });
});

describe("commit-files FIFO destination (022-5-WO1 T004)", () => {
  let dir: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "seepient-cf-fifo-")));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function envelope(path: string): CapabilityEnvelope {
    return {
      version: 1,
      envelopeId: "e1",
      principalId: "u",
      runId: "r1",
      actionDigest: "d1",
      capabilities: [{ kind: "commit-file", path }],
      lifetime: { kind: "action", actionDigest: "d1", consumeOnce: true },
      issuedBy: { kind: "service", authorityId: "pe", authenticatedBy: "deployment" },
      issuedAt: 0,
      policyDigest: "dig",
    };
  }

  it("denies typed within 3 s when the destination is a FIFO and the signal is pre-aborted", async () => {
    const fifo = join(dir, "dest");
    execSync(`mkfifo ${JSON.stringify(fifo)}`);
    writeFileSync(join(dir, "seed"), "seed"); // keep dir non-empty
    const controller = new AbortController();
    controller.abort();

    const action = {
      version: 1,
      actionId: "a1",
      runId: "r1",
      toolCallId: "c1",
      toolName: "write_file",
      principalId: "u",
      argsDigest: "x",
      actionDigest: "d1",
      risk: "edit" as const,
      effects: [],
      display: { title: "t", summary: "s", canonicalTargets: [], effects: [] },
      operation: {
        kind: "commit-files",
        commits: [
          {
            destination: { canonicalPath: fifo, canonicalParent: dir, basename: "dest", exists: true, finalSymlink: false },
            content: { artifactId: "art1", bytes: new Uint8Array([1]) },
            expected: { exists: true, size: 4, sha256: "x".repeat(64) },
          },
        ],
      },
    } as unknown as PreparedToolAction;

    const executor = new CommitFilesExecutor({ commitHelper: { available: true, probe: { available: true, platform: process.platform, binaryPath: "/bin/true" }, async commit() { return { ok: true, writtenSha256: "x" }; } } } as never);
    const outcome = await Promise.race([
      executor.execute(action, envelope(fifo), action.operation as never, { signal: controller.signal }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("no settle in 3s despite aborted signal")), 3000)),
    ]);
    expect(outcome.state).toBe("failed");
    if (outcome.state === "failed") {
      expect(outcome.error.retryable).toBe(false);
    }
  });
});
