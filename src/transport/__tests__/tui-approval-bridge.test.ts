/**
 * Native TUI approval bridge — end-to-end (spec 011, T015, SC-001).
 *
 * Proves the `--permission-pipeline` path carries the full typed
 * `PermissionRequest` to a TUI-shaped presenter and returns a strict,
 * broker-enriched `PermissionDecision` to the lifecycle:
 *   PolicyEngine → request+options → presenter (selection) → broker
 *   (actor/time) → ActionLifecycle → boundary.
 *
 * Also proves the flag-off path retains legacy behavior through
 * `legacyApproveToolToBroker`, and that a missing native broker fails as
 * `approval-unavailable` instead of falling back to the legacy prompt.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildActionLifecycle } from "../../domain/permissions/action-lifecycle-factory.js";
import { InlineApprovalBroker } from "../approval-brokers.js";
import { legacyApproveToolToBroker } from "../legacy-adapter.js";
import type { InlineApprovalPresenter } from "../approval-brokers.js";
import { InMemoryArtifactStore } from "../../capabilities/execution/in-memory-artifact-store.js";
import { buildLocalBoundary } from "../../capabilities/execution/build-local-boundary.js";
import { Agent } from "../cli/agent.js";
import { createSnapshotStore } from "../../foundations/hashline/snapshot-store.js";
import type {
  PermissionRequest,
  TuiApprovalSelection,
} from "../../foundations/contracts/permission-policy.js";
import type { PreparedToolAction } from "../../foundations/contracts/prepared-action.js";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "seepient-bridge-")));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function writeAction(path: string, actionId = "a-bridge"): PreparedToolAction {
  return {
    version: 1,
    actionId,
    runId: "r1",
    toolCallId: "c1",
    toolName: "write_file",
    principalId: "u1",
    argsDigest: "args",
    actionDigest: "ad-bridge",
    risk: "edit",
    effects: [
      {
        kind: "filesystem-write",
        targets: [
          {
            target: {
              canonicalPath: path,
              canonicalParent: dir,
              basename: "x.txt",
              exists: false,
              finalSymlink: false,
            },
            mode: "create",
            expected: { exists: false },
          },
        ],
      },
    ],
    display: {
      title: "Write file",
      summary: "Write file",
      canonicalTargets: [path],
      effects: ["filesystem-write"],
    },
    operation: {
      kind: "commit-files",
      commits: [
        {
          destination: {
            canonicalPath: path,
            canonicalParent: dir,
            basename: "x.txt",
            exists: false,
            finalSymlink: false,
          },
          content: {
            artifactId: "art-bridge",
            sha256: "sha256:bridge",
            byteLength: 4,
            mediaType: "text/plain",
          },
          expected: { exists: false },
        },
      ],
    },
  };
}

describe("native TUI bridge (T015)", () => {
  it("carries the full request to the presenter and enriches the selection (SC-001)", async () => {
    const artifacts = new InMemoryArtifactStore();
    const contentRef = await artifacts.put(Buffer.from("hi\n"), "text/plain", "r1");
    const { boundary } = await buildLocalBoundary({ artifacts, allowFallback: true });

    const received: PermissionRequest[] = [];
    const presenter: InlineApprovalPresenter = {
      async prompt(req): Promise<TuiApprovalSelection> {
        received.push(req);
        return {
          approved: true,
          optionId: req.approvalOptions[0]?.optionId ?? "opt-1",
          lifetime: "action",
        };
      },
    };
    const wired = await buildActionLifecycle({
      principalId: "u1",
      runId: "r1",
      sessionId: "sess-1",
      workspaceRoot: dir,
      modelProviderClass: "openai",
      approvalBroker: new InlineApprovalBroker(presenter, { deadlineMs: 5000 }),
      executionBoundary: boundary,
      auditRoot: dir,
      artifacts,
    });

    const target = join(dir, "x.txt");
    const action = writeAction(target);
    if (action.operation.kind === "commit-files") {
      action.operation.commits[0].content = contentRef;
    }
    const result = await wired.lifecycle.run(action);

    // 1. The presenter saw the complete typed request with policy options.
    expect(received).toHaveLength(1);
    const req = received[0];
    expect(req.requestId).toBeTruthy();
    expect(req.actionDigest).toBe("ad-bridge");
    expect(req.approvalOptions.length).toBeGreaterThan(0);
    expect(req.approvalOptions[0].actionDigest).toBe(req.actionDigest);
    expect(req.sessionId).toBe("sess-1");
    expect(req.offeredLifetimes).toContain("session");

    // 2. The broker enriched the transient selection into a strict decision.
    expect(result.approval?.approved).toBe(true);
    if (result.approval?.approved) {
      expect(result.approval.requestId).toBe(req.requestId);
      expect(result.approval.actionDigest).toBe(req.actionDigest);
      expect(result.approval.optionId).toBe(req.approvalOptions[0].optionId);
      expect(result.approval.lifetime).toBe("action");
      expect(result.approval.actorId).toBe("inline-broker");
      expect(typeof result.approval.decidedAt).toBe("number");
    }

    // 3. The action executed end-to-end.
    expect(result.outcome.state).toBe("succeeded");
    expect(existsSync(target)).toBe(true);
  });

  it("flag-off path keeps legacy behavior but binds approval to a request option", async () => {
    const artifacts = new InMemoryArtifactStore();
    const contentRef = await artifacts.put(Buffer.from("hi\n"), "text/plain", "r1");
    const { boundary } = await buildLocalBoundary({ artifacts, allowFallback: true });

    // Legacy surface: boolean/scope UX, no typed selection.
    const broker = legacyApproveToolToBroker(async () => ({
      approved: true,
      scope: "session",
    }));
    const wired = await buildActionLifecycle({
      principalId: "u1",
      runId: "r1",
      sessionId: "sess-1",
      workspaceRoot: dir,
      modelProviderClass: "openai",
      approvalBroker: broker,
      executionBoundary: boundary,
      auditRoot: dir,
      artifacts,
    });

    const target = join(dir, "x.txt");
    const action = writeAction(target);
    if (action.operation.kind === "commit-files") {
      action.operation.commits[0].content = contentRef;
    }
    const result = await wired.lifecycle.run(action);

    // The legacy adapter bound the approval to the request's narrowest
    // policy-issued option and the offered session lifetime.
    expect(result.approval?.approved).toBe(true);
    if (result.approval?.approved) {
      expect(result.approval.optionId).toBeTruthy();
      expect(result.approval.lifetime).toBe("session");
    }
    expect(result.outcome.state).toBe("succeeded");
    expect(existsSync(target)).toBe(true);
  });

  it("missing native broker denies as approval-unavailable — no legacy fallback (FR-017)", async () => {
    let providerCalls = 0;
    const provider = {
      async chat() {
        providerCalls++;
        if (providerCalls === 1) {
          return {
            content: "",
            tool_calls: [
              {
                id: "tc1",
                name: "write_file",
                arguments: JSON.stringify({ path: join(dir, "x.txt"), content: "x" }),
                type: "function",
              },
            ],
          };
        }
        return { content: "done", tool_calls: [] };
      },
    };
    const agent = new Agent(
      provider as never,
      "test",
      { snapshotStore: createSnapshotStore() },
      "sys",
      null,
      "openai",
    );
    await agent.enablePermissionPipeline({
      workspaceRoot: dir,
      modelProviderClass: "openai",
      auditRoot: dir,
      allowFallback: true,
    });
    // Neither the native broker nor the legacy approveTool is installed.
    await agent.chat(`write to ${join(dir, "x.txt")}`);

    expect(existsSync(join(dir, "x.txt"))).toBe(false);
    const messages = agent.getMessages();
    const lastTool = [...messages].reverse().find((m) => m.role === "tool");
    expect(lastTool?.content ?? "").toContain("approval-unavailable");
  });
});
