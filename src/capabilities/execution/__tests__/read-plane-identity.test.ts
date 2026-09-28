/**
 * Read-plane identity discipline (spec 022-5, FR-001 pin + FR-004).
 *
 * Pins the landed authorize-what-you-open identity binding (absent or
 * mismatched identity never reads) and closes the FIFO/abort wedges: a
 * non-regular file must deny within the test timeout instead of parking
 * the read forever, and a pre-aborted signal must fail fast.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, realpathSync, writeFileSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReadFileExecutor } from "../executors.js";
import type { PreparedToolAction, PreparedOperation } from "../../../foundations/contracts/prepared-action.js";
import type { CapabilityEnvelope } from "../../../foundations/contracts/permission-policy.js";

function mkfifo(p: string): void {
  execSync(`mkfifo ${JSON.stringify(p)}`);
}

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "seepient-read-id-")));
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

/** Build a read-file action with an explicit authorization-time identity. */
function readAction(targetPath: string, expected: Record<string, unknown>): PreparedToolAction {
  return {
    version: 1,
    actionId: "a1",
    runId: "r1",
    toolCallId: "c1",
    toolName: "read_file",
    principalId: "u",
    argsDigest: "x",
    actionDigest: "d1",
    risk: "read" as never,
    effects: [],
    display: { title: "t", summary: "s", canonicalTargets: [], effects: [] },
    operation: {
      kind: "read-file",
      target: { canonicalPath: targetPath, canonicalParent: dir, basename: "x", exists: true, finalSymlink: false },
      expected,
    },
  } as PreparedToolAction;
}

function snapshotIdentity(p: string): Record<string, unknown> {
  const st = statSync(p);
  return { exists: true, device: String(st.dev), inode: String(st.ino), size: st.size };
}

async function run(action: PreparedToolAction, opts?: { signal?: AbortSignal }) {
  return new ReadFileExecutor().execute(
    action,
    envelope((action.operation as { target: { canonicalPath: string } }).target.canonicalPath),
    action.operation as Extract<PreparedOperation, { kind: "read-file" }>,
    opts ?? {},
  );
}

describe("ReadFileExecutor identity pin (022-5 FR-001)", () => {
  it("reads when the opened file matches the authorized identity", async () => {
    const file = join(dir, "ok.txt");
    writeFileSync(file, "content");
    const result = await run(readAction(file, snapshotIdentity(file)));
    expect(result.state).toBe("succeeded");
  });

  it("denies a read-kind action whose prepared identity is absent (fail closed)", async () => {
    const file = join(dir, "no-id.txt");
    writeFileSync(file, "secret");
    const result = await run(readAction(file, { exists: true }));
    expect(result.state).toBe("failed");
    if (result.state === "failed") {
      expect(result.error.code).toBe("PATH_IDENTITY_MISMATCH");
      expect(result.result).toBeUndefined();
    }
  });

  it("denies when the opened file is not the authorized one", async () => {
    const file = join(dir, "a.txt");
    const other = join(dir, "b.txt");
    writeFileSync(file, "authorized");
    writeFileSync(other, "different file");
    const result = await run(readAction(file, snapshotIdentity(other)));
    expect(result.state).toBe("failed");
    if (result.state === "failed") expect(result.error.code).toBe("PATH_IDENTITY_MISMATCH");
  });
});

describe("ReadFileExecutor FIFO and abort (022-5 FR-004)", () => {
  it("denies a FIFO input within the test timeout instead of wedging", async () => {
    const fifo = join(dir, "pipe");
    mkfifo(fifo);
    const result = await Promise.race([
      run(readAction(fifo, snapshotIdentity(fifo))),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("FIFO read wedged the executor")), 3000)),
    ]);
    expect(result.state).toBe("failed");
    if (result.state === "failed") expect(result.error.code).toBe("READ_NOT_REGULAR_FILE");
  });

  it("fails fast when the abort signal is already fired", async () => {
    const file = join(dir, "aborted.txt");
    writeFileSync(file, "content");
    const controller = new AbortController();
    controller.abort();
    const result = await run(readAction(file, snapshotIdentity(file)), { signal: controller.signal });
    expect(result.state).toBe("failed");
    if (result.state === "failed") expect(result.error.code).toBe("READ_ABORTED");
  });
});
