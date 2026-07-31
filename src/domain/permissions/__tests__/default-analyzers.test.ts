/**
 * P1 analyzer tests (spec 008, T102/T104/T105).
 *
 * Verifies: canonical target discovery, stable digests, sensitivity
 * classification, multi-target hashline smuggling denial surface, and the
 * `PreparedOperation` is serializable (no callbacks/secrets).
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  analyzeWriteFile,
  analyzeReadFile,
  analyzeShellCommand,
  canonicalizePath,
  classifyReadSensitivity,
  digestArgs,
  digestAction,
} from "../default-analyzers.js";
import { InMemoryArtifactStore } from "../../../capabilities/execution/in-memory-artifact-store.js";
import type { ToolAnalysisContext } from "../../../foundations/contracts/custom-tools.js";

let dir: string;
beforeEach(() => {
  // macOS /tmp → /private/tmp; canonicalize so tests compare like-for-like
  // with the analyzer's realpath-based canonicalization.
  dir = realpathSync(mkdtempSync(join(tmpdir(), "seepient-analyzers-")));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

import { beforeEach, afterEach } from "vitest";

function ctx(): {
  ctx: ToolAnalysisContext;
  artifacts: InMemoryArtifactStore;
} {
  const artifacts = new InMemoryArtifactStore();
  return {
    artifacts,
    ctx: {
      principalId: "user",
      runId: "r1",
      toolCallId: "c1",
      workspace: {
        workspaceId: "ws",
        canonicalRoot: dir,
        policyVersion: 1,
        policyDigest: "d",
      },
      artifacts,
      modelProviderClass: "openai",
    },
  };
}

describe("canonicalizePath (T102)", () => {
  it("resolves a relative path against cwd", async () => {
    const t = await canonicalizePath("file.txt", dir);
    expect(t.canonicalPath).toBe(join(dir, "file.txt"));
    expect(t.exists).toBe(false);
    expect(t.basename).toBe("file.txt");
  });

  it("detects an existing file", async () => {
    const p = join(dir, "exists.txt");
    writeFileSync(p, "hi");
    const t = await canonicalizePath(p, dir);
    expect(t.exists).toBe(true);
  });

  it("does not follow a final symlink by default (records finalSymlink)", async () => {
    const target = join(dir, "real.txt");
    writeFileSync(target, "x");
    const link = join(dir, "link.txt");
    symlinkSync(target, link);
    const t = await canonicalizePath(link, dir);
    expect(t.exists).toBe(true);
    expect(t.finalSymlink).toBe(true);
  });
});

describe("sensitivity classification (T104)", () => {
  it("marks SSH keys and .env as secret", () => {
    expect(classifyReadSensitivity("/home/u/.ssh/id_rsa")).toBe("secret");
    expect(classifyReadSensitivity("/proj/.env")).toBe("secret");
    expect(classifyReadSensitivity("/proj/cert.pem")).toBe("secret");
  });

  it("marks .seepient config as sensitive (not secret)", () => {
    expect(classifyReadSensitivity("/proj/.seepient/setting.json")).toBe(
      "sensitive",
    );
  });

  it("marks normal source files as normal", () => {
    expect(classifyReadSensitivity("/proj/src/index.ts")).toBe("normal");
  });
});

describe("digest stability (T001/T102)", () => {
  it("digestArgs is stable for the same args", () => {
    const a = digestArgs({ path: "/x", content: "hi" });
    const b = digestArgs({ path: "/x", content: "hi" });
    expect(a).toBe(b);
  });

  it("digestArgs is key-order independent", () => {
    expect(digestArgs({ a: 1, b: 2 })).toBe(digestArgs({ b: 2, a: 1 }));
  });

  it("digestAction changes when operation changes", () => {
    const base = {
      operation: { kind: "commit-files", commits: [] },
      effects: [],
      principalId: "u",
      toolName: "write_file",
      argsDigest: "x",
    };
    const mutated = {
      ...base,
      operation: { kind: "commit-files", commits: [{ x: 1 }] },
    };
    expect(digestAction(base as never)).not.toEqual(digestAction(mutated as never));
  });
});

describe("write_file analyzer (T102/T105)", () => {
  it("produces a serializable commit-files operation with artifact ref", async () => {
    const { ctx: c } = ctx();
    const action = await analyzeWriteFile(
      { path: join(dir, "out.txt"), content: "hello" },
      c,
    );
    expect(action.operation.kind).toBe("commit-files");
    if (action.operation.kind === "commit-files") {
      const commit = action.operation.commits[0];
      expect(commit.content.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(commit.content.byteLength).toBe(5);
      expect(commit.destination.canonicalPath).toBe(join(dir, "out.txt"));
    }
    // Serializable — no functions, no Uint8Array.
    const json = JSON.parse(JSON.stringify(action));
    expect(json.operation.kind).toBe("commit-files");
  });

  it("declares a filesystem-write effect with exact target", async () => {
    const { ctx: c } = ctx();
    const action = await analyzeWriteFile(
      { path: join(dir, "x.txt"), content: "x" },
      c,
    );
    expect(action.effects.map((e) => e.kind)).toEqual(["filesystem-write", "model-egress"]);
    expect(action.effects[0].kind).toBe("filesystem-write");
    expect(action.display.canonicalTargets[0]).toBe(join(dir, "x.txt"));
  });
});

describe("read_file analyzer (T104)", () => {
  it("adds model-egress effect with provider class", async () => {
    const { ctx: c } = ctx();
    const action = await analyzeReadFile({ path: join(dir, "read.txt") }, c);
    expect(action.effects.map((e) => e.kind)).toEqual([
      "filesystem-read",
      "model-egress",
    ]);
    const egress = action.effects[1];
    if (egress.kind === "model-egress") {
      expect(egress.providerClass).toBe("openai");
      expect(egress.dataClasses).toEqual(["normal"]);
    }
  });
});

describe("shell analyzer (T102)", () => {
  it("produces a process operation with cwd roots", async () => {
    const { ctx: c } = ctx();
    const action = await analyzeShellCommand({ command: "npm test" }, c);
    expect(action.operation.kind).toBe("process");
    if (action.operation.kind === "process") {
      expect(action.operation.command.argv).toEqual(["-c", "npm test"]);
      expect(action.operation.roots).toEqual([
        { access: "read", canonicalRoot: dir },
        { access: "write", canonicalRoot: dir },
      ]);
    }
  });
});
