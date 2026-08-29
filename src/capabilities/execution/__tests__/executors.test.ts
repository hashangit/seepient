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
  BrokerExecutor,
} from "../executors.js";
import { EffectBroker } from "../effect-broker.js";
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

describe("ReadFileExecutor snapshot parity (spec 019 FR-001, T015)", () => {
  it("records the content and appends [content-tag:N] when a store is wired", async () => {
    const { createSnapshotStore, tagFor } = await import("../../../foundations/hashline/snapshot-store.js");
    const store = createSnapshotStore();
    const file = join(dir, "tagged.txt");
    const content = "line 1\nline 2\n";
    writeFileSync(file, content);
    const executor = new ReadFileExecutor({ snapshotStore: store });
    const action = actionWith("read-file", { destinationPath: file });
    const result = await executor.execute(action, envelope(file), asOp(action.operation, "read-file"), {});
    expect(result.state).toBe("succeeded");
    if (result.state === "succeeded") {
      // Legacy contract byte-for-byte (core.ts:77-79): content + blank line
      // + tag, so a following edit_file patch header is valid.
      const expectedTag = tagFor(file, content);
      expect(result.result.output).toBe(`${content}\n\n[content-tag:${expectedTag}]`);
    }
    // The store gained the entry — the pipeline read→edit loop can resolve it.
    expect(store.resolvePath(file)).not.toBeNull();
  });

  it("returns raw content when no store is wired (unchanged behavior)", async () => {
    const file = join(dir, "raw.txt");
    writeFileSync(file, "raw content");
    const executor = new ReadFileExecutor();
    const action = actionWith("read-file", { destinationPath: file });
    const result = await executor.execute(action, envelope(file), asOp(action.operation, "read-file"), {});
    expect(result.state).toBe("succeeded");
    if (result.state === "succeeded") expect(result.result.output).toBe("raw content");
  });

  it("keeps the security-path denial unchanged", async () => {
    const { createSnapshotStore } = await import("../../../foundations/hashline/snapshot-store.js");
    const executor = new ReadFileExecutor({ snapshotStore: createSnapshotStore() });
    const secPath = `${process.env.HOME ?? "~"}/.seepient/security/keys.json`;
    const action = actionWith("read-file", { destinationPath: secPath });
    const result = await executor.execute(action, envelope(secPath), asOp(action.operation, "read-file"), {});
    expect(result.state).toBe("failed");
    if (result.state === "failed") expect(result.error.code).toBe("SECURITY_PATH_DENIED");
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
  it("fails closed with EXACT_COMMIT_UNAVAILABLE when the helper is unavailable", async () => {
    const artifacts = new InMemoryArtifactStore();
    const broker = new FileCommitBroker({ artifacts, helper: fakeHelper() as never });
    const dest = join(dir, "out.txt");
    const contentRef = await artifacts.put(Buffer.from("content"), "text/plain");
    const executor = new CommitFilesExecutor({ broker, artifacts, useNative: false });
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
    // Pin the helper to unavailable: the dev tree may or may not carry a
    // binary built via `pnpm native:build` (spec 019 QS-1.5).
    const { fakeHelper } = await import("./helpers/commit-helper-fakes.js");
    const { boundary } = await buildLocalBoundary({ artifacts, commitHelper: fakeHelper({ available: false }) });
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

describe("BrokerExecutor web_search formatting", () => {
  it("formats Tavily search results into compact markdown snippet", async () => {
    const prevKey = process.env.TAVILY_API_KEY;
    process.env.TAVILY_API_KEY = "tvly-test-key";
    try {
      const artifacts = new InMemoryArtifactStore();
    const fixtureTavilyJson = JSON.stringify({
      query: "finland unemployment rate",
      answer: "The unemployment rate in Finland is 8.2% as of July 2026.",
      response_time: 0.45,
      results: [
        {
          title: "Statistics Finland - Employment Bulletin",
          url: "https://stat.fi/en/statistics/tyok",
          content: "According to Statistics Finland's Labour Force Survey, the unemployment rate was 8.2 per cent in July 2026, compared to 7.9 per cent a year earlier. ".repeat(15),
          score: 0.98,
          raw_content: "<html>full raw dump</html>",
        },
      ],
    });

    const mockNetwork = {
      resolve: async () => ["1.1.1.1"],
      fetch: async () => ({
        status: 200,
        bytes: Buffer.from(fixtureTavilyJson, "utf8"),
        effectiveHost: "api.tavily.com",
        effectiveIp: "1.1.1.1",
        headers: {},
      }),
    };

    const broker = new EffectBroker({
      artifacts,
      network: mockNetwork,
    });

    const executor = new BrokerExecutor({ broker, artifacts });
    const action: PreparedToolAction = {
      version: 1,
      actionId: "a-search",
      runId: "r1",
      toolCallId: "c1",
      toolName: "web_search",
      principalId: "u",
      argsDigest: "dig",
      actionDigest: "d1",
      risk: "safe",
      effects: [],
      display: { title: "Web search", summary: "finland unemployment", canonicalTargets: [], effects: [] },
      operation: {
        kind: "broker",
        request: {
          kind: "http",
          requestId: "req-1",
          destination: { scheme: "https", host: "api.tavily.com", pathPrefix: "/search" },
          method: "POST",
          headers: { "Content-Type": "application/json" },
          secretRefs: ["tavilyApiKey"],
        },
      },
    };

    const env: CapabilityEnvelope = {
      version: 1,
      envelopeId: "e1",
      principalId: "u",
      runId: "r1",
      actionDigest: "d1",
      capabilities: [{ kind: "network-destination", scheme: "https", host: "api.tavily.com" }],
      lifetime: { kind: "action", actionDigest: "d1", consumeOnce: true },
      issuedBy: { kind: "service", authorityId: "pe", authenticatedBy: "deployment" },
      issuedAt: 0,
      policyDigest: "dig",
    };

    const result = await executor.execute(action, env, asOp(action.operation, "broker"), {});
    expect(result.state).toBe("succeeded");
    if (result.state === "succeeded") {
      const out = result.result.output;
      expect(out).toContain("[HTTP 200 https://api.tavily.com/search]");
      expect(out).toContain("**Direct answer**: The unemployment rate in Finland is 8.2% as of July 2026.");
      expect(out).toContain("1. **Statistics Finland - Employment Bulletin**");
      expect(out).toContain("https://stat.fi/en/statistics/tyok");
      expect(out).toContain("…"); // truncated long snippet
      expect(out).not.toContain('"score":');
      expect(out).not.toContain('"response_time":');
    }
    } finally {
      if (prevKey === undefined) delete process.env.TAVILY_API_KEY;
      else process.env.TAVILY_API_KEY = prevKey;
    }
  });
});

// Re-export to satisfy type-only import in test file.
export { sanitizeEnvironment };
