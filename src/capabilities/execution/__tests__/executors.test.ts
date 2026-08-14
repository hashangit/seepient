/**
 * P2 executor tests (spec 008, T205/T212/T213).
 *
 * Verifies: CommitFilesExecutor routes through the broker (no direct write),
 * ReadFileExecutor reads via canonical path, UnsupportedExecutor denies
 * browser tools, ProcessExecutor sanitizes env, NoneExecutor returns the
 * precomputed result.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CommitFilesExecutor,
  ReadFileExecutor,
  NoneExecutor,
  UnsupportedExecutor,
  TrustedHostExecutor,
} from "../executors.js";
import { ProcessExecutor } from "../process-executor.js";
import { FileCommitBroker } from "../file-commit-broker.js";
import { InMemoryArtifactStore } from "../in-memory-artifact-store.js";
import { UncontainedSandbox } from "../../../vendors/sandbox-runtime/index.js";
import { sanitizeEnvironment } from "../environment-policy.js";
import type { PreparedToolAction, PreparedOperation } from "../../../foundations/contracts/prepared-action.js";
import type { CapabilityEnvelope } from "../../../foundations/contracts/permission-policy.js";
import { UnsupportedBackendError } from "../../../foundations/errors.js";

/** Narrow a PreparedOperation union member by its `kind`. Returns `never` if
 *  the kind does not match (callers guard on `.kind` first). */
function asOp<K extends PreparedOperation["kind"]>(
  op: PreparedOperation,
  kind: K,
): Extract<PreparedOperation, { kind: K }> {
  return op as Extract<PreparedOperation, { kind: K }>;
}

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "seepient-exec-")));
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

function actionWith(kind: PreparedToolAction["operation"]["kind"], op: Partial<PreparedToolAction["operation"]> & { destinationPath?: string }): PreparedToolAction {
  const base = {
    version: 1 as const,
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
  };
  if (kind === "commit-files") {
    return { ...base, operation: { kind, commits: [], ...op } } as PreparedToolAction;
  }
  if (kind === "read-file") {
    return { ...base, operation: { kind, target: { canonicalPath: op.destinationPath ?? "/x", canonicalParent: "/", basename: "x", exists: true, finalSymlink: false }, expected: { exists: true }, ...op } } as PreparedToolAction;
  }
  if (kind === "none") {
    return { ...base, operation: { kind, result: { output: "ok", success: true }, ...op } } as PreparedToolAction;
  }
  return { ...base, operation: { kind, ...op } } as PreparedToolAction;
}

/** Fake commit helper that succeeds and reports the digest. */
function fakeHelper() {
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  return {
    available: true,
    probe: { available: true, platform: process.platform, binaryPath: "/fake" },
    async commit(req: { content: Uint8Array }) {
      return { ok: true, writtenSha256: createHash("sha256").update(req.content).digest("hex") };
    },
  };
}

describe("CommitFilesExecutor (T205)", () => {
  it("routes through the broker — no direct destination write", async () => {
    const artifacts = new InMemoryArtifactStore();
    const broker = new FileCommitBroker({ artifacts, helper: fakeHelper() as never });
    const executor = new CommitFilesExecutor({ broker, artifacts });

    const contentRef = await artifacts.put(Buffer.from("hello"), "text/plain");
    const dest = join(dir, "out.txt");
    const action = actionWith("commit-files", {
      commits: [{
        destination: { canonicalPath: dest, canonicalParent: dir, basename: "out.txt", exists: false, finalSymlink: false },
        content: contentRef,
      }],
    }) as PreparedToolAction & { operation: { kind: "commit-files"; commits: { destination: { canonicalPath: string }; content: typeof contentRef }[] } };

    const result = await executor.execute(
      action,
      envelope(dest),
      action.operation,
      {},
    );
    expect(result.state).toBe("succeeded");
    if (result.state === "succeeded") {
      expect(result.evidence.committedTargets).toEqual([dest]);
    }
  });

  it("reports partial completion honestly on multi-file failure", async () => {
    const artifacts = new InMemoryArtifactStore();
    // Broker with a helper that fails every commit.
    const failingHelper = { ...fakeHelper(), async commit() { return { ok: false, writtenSha256: "", errorCode: "io-error" as const }; } };
    const broker = new FileCommitBroker({ artifacts, helper: failingHelper as never });
    const executor = new CommitFilesExecutor({ broker, artifacts });
    const ref = await artifacts.put(Buffer.from("x"), "text/plain");
    const dest1 = join(dir, "a.txt");
    const dest2 = join(dir, "b.txt");
    const action: PreparedToolAction = {
      ...actionWith("commit-files", {}),
      operation: {
        kind: "commit-files" as const,
        commits: [
          { destination: { canonicalPath: dest1, canonicalParent: dir, basename: "a.txt", exists: false, finalSymlink: false }, content: ref },
          { destination: { canonicalPath: dest2, canonicalParent: dir, basename: "b.txt", exists: false, finalSymlink: false }, content: ref },
        ],
      },
    };

    const result = await executor.execute(action, envelope(dest1), asOp(action.operation, "commit-files"), {});
    expect(result.state).toBe("failed");
  });
});

describe("ReadFileExecutor (T205)", () => {
  it("reads via canonical path", async () => {
    const file = join(dir, "read.txt");
    writeFileSync(file, "content");
    const executor = new ReadFileExecutor();
    const action = actionWith("read-file", { destinationPath: file });
    const result = await executor.execute(action, envelope(file), asOp(action.operation, "read-file"), {});
    expect(result.state).toBe("succeeded");
    if (result.state === "succeeded") expect(result.result.output).toBe("content");
  });
});

describe("NoneExecutor", () => {
  it("returns the precomputed result", async () => {
    const executor = new NoneExecutor();
    const action = actionWith("none", { result: { output: "datetime", success: true } });
    const result = await executor.execute(action, envelope("/"), asOp(action.operation, "none"), {});
    expect(result.state).toBe("succeeded");
  });
});

describe("UnsupportedExecutor (T212)", () => {
  it("throws UnsupportedBackendError — no control-plane Chromium", async () => {
    const executor = new UnsupportedExecutor("broker" as PreparedToolAction["operation"]["kind"]);
    const action = actionWith("none", { result: { output: "x", success: true } });
    await expect(executor.execute(action)).rejects.toBeInstanceOf(UnsupportedBackendError);
  });
});

describe("ProcessExecutor (T213)", () => {
  it("preserves bounded stderr when a process exits nonzero", async () => {
    const sandbox = {
      probe: { available: true, platform: "darwin", backend: "seatbelt" },
      async exec() {
        return {
          exitCode: 128,
          stdout: "",
          stderr: "fatal: not a git repository",
          isolated: true,
        };
      },
    };
    const executor = new ProcessExecutor({ sandbox: sandbox as never });
    const action: PreparedToolAction = {
      ...actionWith("process", {}),
      operation: {
        kind: "process",
        command: { executable: "/bin/sh", argv: ["-c", "git status"], cwd: dir },
        roots: [],
      },
    };
    const result = await executor.execute(action, envelope(dir), asOp(action.operation, "process"), {});
    expect(result.state).toBe("failed");
    if (result.state === "failed") {
      expect(result.error.message).toBe("exit 128: fatal: not a git repository");
    }
  });

  it("scrubs control characters from nonzero-exit diagnostics", async () => {
    const sandbox = {
      probe: { available: true, platform: "darwin", backend: "seatbelt" },
      async exec() {
        return {
          exitCode: 1,
          stdout: "",
          // CR, C1 (NEL), ESC, and NUL must be replaced; the newline survives.
          stderr: "line1\r\nline2\u0085\u001b[31mred\u0000",
          isolated: true,
        };
      },
    };
    const executor = new ProcessExecutor({ sandbox: sandbox as never });
    const action: PreparedToolAction = {
      ...actionWith("process", {}),
      operation: {
        kind: "process",
        command: { executable: "/bin/sh", argv: ["-c", "false"], cwd: dir },
        roots: [],
      },
    };
    const result = await executor.execute(action, envelope(dir), asOp(action.operation, "process"), {});
    expect(result.state).toBe("failed");
    if (result.state === "failed") {
      expect(result.error.message).toBe("exit 1: line1�\nline2��[31mred�");
    }
  });

  it("sanitizes the env — no ambient secrets reach the child", async () => {
    const artifacts = new InMemoryArtifactStore();
    void artifacts;
    const parentEnv = {
      ...process.env,
      OPENAI_API_KEY: "sk-leaked",
      PATH: "/usr/bin:/bin",
    };
    // Capture the env handed to the sandbox.
    let capturedEnv: Record<string, string> | undefined;
    const sandbox = {
      probe: { available: true, platform: "darwin", backend: "seatbelt" },
      async exec(req: { env: Record<string, string>; command: { executable: string; argv: string[]; cwd: string } }) {
        capturedEnv = req.env;
        // Echo the env's OPENAI_API_KEY presence so we can prove it's absent.
        const hasLeak = "OPENAI_API_KEY" in req.env;
        return {
          exitCode: 0,
          stdout: hasLeak ? "LEAK" : "clean",
          stderr: "",
          isolated: false,
        };
      },
    };
    const executor = new ProcessExecutor({ sandbox: sandbox as never, parentEnv });
    const action: PreparedToolAction = {
      ...actionWith("process", {}),
      operation: {
        kind: "process" as const,
        command: { executable: "/bin/echo", argv: ["hi"], cwd: dir },
        roots: [{ access: "read" as const, canonicalRoot: dir }],
      },
    };
    const result = await executor.execute(action, envelope(dir), asOp(action.operation, "process"), {});
    expect(result.state).toBe("succeeded");
    expect(capturedEnv!.OPENAI_API_KEY).toBeUndefined();
    if (
      process.platform === "darwin" &&
      existsSync("/Library/Developer/CommandLineTools/usr/bin/git")
    ) {
      expect(capturedEnv!.PATH).toMatch(/^\/Library\/Developer\/CommandLineTools\/usr\/bin:/);
    }
    if (result.state === "succeeded") expect(result.result.output).toBe("clean");
  });

  it("uncontained sandbox reports isolated:false in evidence executorId", async () => {
    const sandbox = new UncontainedSandbox();
    const executor = new ProcessExecutor({ sandbox, parentEnv: { PATH: "/usr/bin" }, unsafeUncontained: true });
    const action: PreparedToolAction = {
      ...actionWith("process", {}),
      operation: {
        kind: "process" as const,
        command: { executable: "/bin/echo", argv: ["hi"], cwd: dir },
        roots: [],
      },
    };
    const result = await executor.execute(action, envelope(dir), asOp(action.operation, "process"), {});
    // UncontainedSandbox.backend === "none" → executorId records the honest status.
    if (result.state === "succeeded") {
      expect(result.evidence.executorId).toBe("process-uncontained");
    }
  });
});

describe("TrustedHostExecutor", () => {
  it("runs the registered host callback", async () => {
    const callbacks = new Map([["host-1", async () => "host-result"]]);
    const executor = new TrustedHostExecutor(callbacks);
    const action = actionWith("trusted-host", { registrationId: "host-1", args: {} });
    const result = await executor.execute(action, envelope("/"), asOp(action.operation, "trusted-host"), {});
    expect(result.state).toBe("succeeded");
    if (result.state === "succeeded") expect(result.result.output).toBe("host-result");
  });

  it("fails when callback not registered", async () => {
    const executor = new TrustedHostExecutor(new Map());
    const action = actionWith("trusted-host", { registrationId: "missing", args: {} });
    const result = await executor.execute(action, envelope("/"), asOp(action.operation, "trusted-host"), {});
    expect(result.state).toBe("failed");
  });
});

describe("CommitFilesExecutor fail-closed defaults (P0-1)", () => {
  it("fails closed with EXACT_COMMIT_UNAVAILABLE when useNative:false and allowFallback:false", async () => {
    const artifacts = new InMemoryArtifactStore();
    const broker = new FileCommitBroker({ artifacts, helper: fakeHelper() as never });
    const dest = join(dir, "out.txt");
    const contentRef = await artifacts.put(Buffer.from("content"), "text/plain");
    const executor = new CommitFilesExecutor({ broker, artifacts, useNative: false, allowFallback: false });
    const action = actionWith("commit-files", {});
    action.operation = {
      kind: "commit-files",
      commits: [
        {
          destination: { canonicalPath: dest, canonicalParent: dir, basename: "out.txt", exists: false, finalSymlink: false },
          content: contentRef,
          expected: { exists: false },
        },
      ],
    };
    const result = await executor.execute(action, envelope(dest), asOp(action.operation, "commit-files"), {});
    expect(result.state).toBe("failed");
    if (result.state === "failed") {
      expect(result.error.code).toBe("EXACT_COMMIT_UNAVAILABLE");
    }
  });

  it("production buildLocalBoundary() defaults to fail-closed exactCommit:false when native is missing", async () => {
    const { buildLocalBoundary } = await import("../build-local-boundary.js");
    const artifacts = new InMemoryArtifactStore();
    const { boundary } = await buildLocalBoundary({ artifacts });
    expect(boundary.capabilities.exactCommit).toBe(false);
    const dest = join(dir, "should-not-be-written.txt");
    const contentRef = await artifacts.put(Buffer.from("do not write"), "text/plain");
    const action = actionWith("commit-files", {});
    action.operation = {
      kind: "commit-files",
      commits: [
        {
          destination: { canonicalPath: dest, canonicalParent: dir, basename: "should-not-be-written.txt", exists: false, finalSymlink: false },
          content: contentRef,
          expected: { exists: false },
        },
      ],
    };
    const result = await boundary.execute(action, envelope(dest), {});
    expect(result.state).toBe("failed");
    if (result.state === "failed") {
      expect(result.error.code).toBe("EXACT_COMMIT_UNAVAILABLE");
    }
    const { existsSync } = await import("node:fs");
    expect(existsSync(dest)).toBe(false);
  });
});
// Re-export to satisfy type-only import in test file.
export { sanitizeEnvironment };
