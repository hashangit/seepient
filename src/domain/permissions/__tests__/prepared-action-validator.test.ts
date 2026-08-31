import { describe, it, expect, beforeEach } from "vitest";
import {
  buildPreparedAction,
  PreparedActionError,
} from "../prepared-action-validator.js";
import type {
  PreparedToolRegistration,
  ToolAnalysisContext,
  PreparedActionDraft,
} from "../../../foundations/contracts/custom-tools.js";
import type { CanonicalPathTarget } from "../../../foundations/contracts/tool-effects.js";
import { InMemoryArtifactStore } from "../../../capabilities/execution/in-memory-artifact-store.js";
import { createSnapshotStore } from "../../../foundations/hashline/snapshot-store.js";
import { digestAction, digestArgs } from "../../../capabilities/tools/analyzers.js";

function sampleTarget(path = "/mock/workspace/report.txt"): CanonicalPathTarget {
  return {
    canonicalPath: path,
    canonicalParent: "/mock/workspace",
    basename: "report.txt",
    exists: false,
    finalSymlink: false,
  };
}

function sampleCommitDraft(): PreparedActionDraft {
  const target = sampleTarget();
  return {
    operation: {
      kind: "commit-files",
      commits: [
        {
          destination: target,
          content: { artifactId: "a1", sha256: "d1", byteLength: 10, mediaType: "text/plain" },
        },
      ],
    },
    effects: [
      {
        kind: "filesystem-write",
        targets: [{ target, mode: "create" }],
      },
    ],
    risk: "edit",
    display: {
      title: "Save Report",
      summary: "Writes report.txt",
      canonicalTargets: [target.canonicalPath],
      effects: ["filesystem-write"],
    },
  };
}

describe("Prepared Action Validator (QS-0.1 – QS-0.7)", () => {
  let ctx: ToolAnalysisContext;
  let sampleRegistration: PreparedToolRegistration;

  beforeEach(() => {
    ctx = {
      principalId: "user-123",
      runId: "run-456",
      toolCallId: "call-789",
      workspace: {
        workspaceId: "ws-1",
        canonicalRoot: "/mock/workspace",
        policyVersion: 1,
        policyDigest: "dig-1",
      },
      artifacts: new InMemoryArtifactStore(),
      modelProviderClass: "anthropic",
      snapshotStore: createSnapshotStore(),
    };

    sampleRegistration = {
      kind: "prepared",
      trust: "analyzer",
      definition: {
        type: "function",
        function: {
          name: "save_report",
          description: "Save a generated report",
          parameters: {
            type: "object",
            properties: { path: { type: "string" }, content: { type: "string" } },
            required: ["path", "content"],
          },
        },
      },
      allowedOperationKinds: ["commit-files"],
      analyze: async () => sampleCommitDraft(),
    };
  });

  it("QS-0.1: constructs ValidatedPreparedAction from well-formed draft with platform identity & digests", () => {
    const rawArgs = { path: "report.txt", content: "hello world" };
    const draft = sampleCommitDraft();

    const action = buildPreparedAction(draft, sampleRegistration, ctx, rawArgs);

    expect(action.version).toBe(1);
    expect(action.principalId).toBe(ctx.principalId);
    expect(action.runId).toBe(ctx.runId);
    expect(action.toolCallId).toBe(ctx.toolCallId);
    expect(action.toolName).toBe("save_report");
    expect(action.risk).toBe("edit");
    expect(action.display.title).toBe("Save Report");
    expect(action.operation.kind).toBe("commit-files");

    const expectedArgsDigest = digestArgs(rawArgs);
    expect(action.argsDigest).toBe(expectedArgsDigest);

    const expectedActionDigest = digestAction({
      operation: action.operation,
      effects: action.effects,
      principalId: ctx.principalId,
      toolName: "save_report",
      argsDigest: expectedArgsDigest,
      runId: ctx.runId,
      toolCallId: ctx.toolCallId,
    });
    expect(action.actionDigest).toBe(expectedActionDigest);
  });

  it("QS-0.2: throws PREPARED_ACTION_INVALID_SHAPE for malformed draft shapes", () => {
    const rawArgs = {};

    // Not an object / null
    expect(() => buildPreparedAction(null, sampleRegistration, ctx, rawArgs))
      .toThrow(PreparedActionError);
    try {
      buildPreparedAction(null, sampleRegistration, ctx, rawArgs);
    } catch (err: any) {
      expect(err.code).toBe("PREPARED_ACTION_INVALID_SHAPE");
      expect(err.retryable).toBe(false);
    }

    // Missing operation
    expect(() =>
      buildPreparedAction(
        {
          effects: [{ kind: "filesystem-write", targets: [{ target: sampleTarget(), mode: "create" }] }],
          risk: "edit",
          display: { title: "T", summary: "T", canonicalTargets: [], effects: ["filesystem-write"] },
        },
        sampleRegistration,
        ctx,
        rawArgs,
      ),
    ).toThrow(PreparedActionError);

    // Missing effects or non-array
    expect(() =>
      buildPreparedAction(
        {
          operation: { kind: "commit-files", commits: [] },
          effects: "not-an-array",
          risk: "edit",
          display: { title: "T", summary: "T", canonicalTargets: [], effects: ["filesystem-write"] },
        },
        sampleRegistration,
        ctx,
        rawArgs,
      ),
    ).toThrow(PreparedActionError);

    // Missing risk or invalid risk category
    expect(() =>
      buildPreparedAction(
        {
          operation: { kind: "commit-files", commits: [] },
          effects: [{ kind: "filesystem-write", targets: [{ target: sampleTarget(), mode: "create" }] }],
          risk: "ultra-high-super-risk" as any,
          display: { title: "T", summary: "T", canonicalTargets: [], effects: ["filesystem-write"] },
        },
        sampleRegistration,
        ctx,
        rawArgs,
      ),
    ).toThrow(PreparedActionError);

    // Missing display or display without title
    expect(() =>
      buildPreparedAction(
        {
          operation: { kind: "commit-files", commits: [] },
          effects: [{ kind: "filesystem-write", targets: [{ target: sampleTarget(), mode: "create" }] }],
          risk: "edit",
          display: {},
        },
        sampleRegistration,
        ctx,
        rawArgs,
      ),
    ).toThrow(PreparedActionError);
  });

  it("QS-0.3: throws PREPARED_ACTION_KIND_NOT_DECLARED when emitting undeclared operation kind", () => {
    const rawArgs = {};
    const draft = {
      operation: { kind: "process", command: { executable: "ls", argv: ["ls"] }, roots: [] },
      effects: [{ kind: "process-exec", executable: "ls", argv: ["ls"] }],
      risk: "safe" as const,
      display: { title: "Process", summary: "P", canonicalTargets: [], effects: ["process-exec" as const] },
    };

    // Registration declared only ['commit-files']
    expect(() => buildPreparedAction(draft, sampleRegistration, ctx, rawArgs)).toThrowError(
      /PREPARED_ACTION_KIND_NOT_DECLARED/,
    );
    try {
      buildPreparedAction(draft, sampleRegistration, ctx, rawArgs);
    } catch (err: any) {
      expect(err.code).toBe("PREPARED_ACTION_KIND_NOT_DECLARED");
    }
  });

  it("QS-0.4: throws PREPARED_ACTION_KIND_UNSUPPORTED when operation kind is outside closed supported set", () => {
    const rawArgs = {};
    const badReg: PreparedToolRegistration = {
      ...sampleRegistration,
      allowedOperationKinds: ["custom-alien-op" as any],
    };
    const draft = {
      operation: { kind: "custom-alien-op" as any },
      effects: [{ kind: "filesystem-write", targets: [{ target: sampleTarget(), mode: "create" }] }],
      risk: "edit" as const,
      display: { title: "Alien", summary: "A", canonicalTargets: [], effects: ["filesystem-write" as const] },
    };

    expect(() => buildPreparedAction(draft, badReg, ctx, rawArgs)).toThrowError(
      /PREPARED_ACTION_KIND_UNSUPPORTED/,
    );
    try {
      buildPreparedAction(draft, badReg, ctx, rawArgs);
    } catch (err: any) {
      expect(err.code).toBe("PREPARED_ACTION_KIND_UNSUPPORTED");
    }
  });

  it("QS-0.5: throws PREPARED_ACTION_EFFECTS_INVALID for empty or inconsistent effects", () => {
    const rawArgs = {};
    const validCommits = [
      {
        destination: sampleTarget(),
        content: { artifactId: "a1", sha256: "d1", byteLength: 10, mediaType: "text/plain" },
      },
    ];

    // Empty effects array
    expect(() =>
      buildPreparedAction(
        {
          operation: { kind: "commit-files", commits: validCommits },
          effects: [],
          risk: "edit",
          display: { title: "Empty Effects", summary: "E", canonicalTargets: [], effects: [] },
        },
        sampleRegistration,
        ctx,
        rawArgs,
      ),
    ).toThrowError(/PREPARED_ACTION_EFFECTS_INVALID/);

    // commit-files with no filesystem-write effect
    expect(() =>
      buildPreparedAction(
        {
          operation: { kind: "commit-files", commits: validCommits },
          effects: [{ kind: "filesystem-read", targets: [sampleTarget()] }],
          risk: "edit",
          display: { title: "Wrong Effect", summary: "W", canonicalTargets: [], effects: ["filesystem-read"] },
        },
        sampleRegistration,
        ctx,
        rawArgs,
      ),
    ).toThrowError(/PREPARED_ACTION_EFFECTS_INVALID/);

    // commit-files with filesystem-write but mismatching target path
    expect(() =>
      buildPreparedAction(
        {
          operation: { kind: "commit-files", commits: validCommits },
          effects: [{ kind: "filesystem-write", targets: [{ target: sampleTarget("/other/path.txt"), mode: "create" }] }],
          risk: "edit",
          display: { title: "Mismatch Target", summary: "M", canonicalTargets: [], effects: ["filesystem-write"] },
        },
        sampleRegistration,
        ctx,
        rawArgs,
      ),
    ).toThrowError(/PREPARED_ACTION_EFFECTS_INVALID/);
  });

  it("QS-0.6: ensures every PreparedActionError carries remediation naming the field and guide", () => {
    const rawArgs = {};
    const codes = [
      () => buildPreparedAction(null, sampleRegistration, ctx, rawArgs),
      () =>
        buildPreparedAction(
          {
            operation: { kind: "process", command: { executable: "echo", argv: [] }, roots: [] },
            effects: [{ kind: "process-exec", executable: "echo", argv: [] }],
            risk: "safe",
            display: { title: "Echo", summary: "E", canonicalTargets: [], effects: ["process-exec"] },
          },
          sampleRegistration,
          ctx,
          rawArgs,
        ),
      () =>
        buildPreparedAction(
          {
            operation: { kind: "unknown-kind" as any },
            effects: [{ kind: "filesystem-write", targets: [{ target: sampleTarget(), mode: "create" }] }],
            risk: "edit",
            display: { title: "Unknown", summary: "U", canonicalTargets: [], effects: ["filesystem-write"] },
          },
          { ...sampleRegistration, allowedOperationKinds: ["unknown-kind" as any] },
          ctx,
          rawArgs,
        ),
      () =>
        buildPreparedAction(
          {
            operation: { kind: "commit-files", commits: [] },
            effects: [],
            risk: "edit",
            display: { title: "No Effects", summary: "N", canonicalTargets: [], effects: [] },
          },
          sampleRegistration,
          ctx,
          rawArgs,
        ),
    ];

    for (const fn of codes) {
      try {
        fn();
        expect.unreachable("Should have thrown PreparedActionError");
      } catch (err: any) {
        expect(err).toBeInstanceOf(PreparedActionError);
        expect(err.remediation).toBeDefined();
        expect(typeof err.remediation).toBe("string");
        expect(err.remediation.length).toBeGreaterThan(10);
        expect(err.retryable).toBe(false);
      }
    }
  });

  it("QS-0.7: author cannot influence stamped identity, digests, or mutate action post-construction", () => {
    const rawArgs = { a: 1 };
    const draft: any = {
      operation: {
        kind: "commit-files",
        commits: [{ destination: sampleTarget(), content: { artifactId: "a1", sha256: "d1", byteLength: 1, mediaType: "text/plain" } }],
      },
      effects: [{ kind: "filesystem-write", targets: [{ target: sampleTarget(), mode: "create" }] }],
      risk: "edit",
      display: { title: "Forged Action", summary: "F", canonicalTargets: [], effects: ["filesystem-write"] },
      // Attempting to forge identity fields
      principalId: "attacker-root",
      runId: "forged-run",
      toolCallId: "forged-tool-call",
      actionDigest: "forged-digest-000000",
      argsDigest: "forged-args-000000",
    };

    const action = buildPreparedAction(draft, sampleRegistration, ctx, rawArgs);

    // Stamped fields must come strictly from context and platform calculations
    expect(action.principalId).toBe(ctx.principalId);
    expect(action.runId).toBe(ctx.runId);
    expect(action.toolCallId).toBe(ctx.toolCallId);
    expect(action.actionDigest).not.toBe("forged-digest-000000");
    expect(action.argsDigest).not.toBe("forged-args-000000");

    // Mutation of original draft must not affect the stamped action
    draft.operation.kind = "process";
    draft.display.title = "Mutated Title";
    expect(action.operation.kind).toBe("commit-files");
    expect(action.display.title).toBe("Forged Action");
  });
});
