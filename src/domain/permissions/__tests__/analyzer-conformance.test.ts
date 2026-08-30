/**
 * Analyzer conformance tests (spec 017, T018 / QS-3).
 *
 * Verifies:
 *   1. Every built-in analyzer whose output re-enters model history declares a model-egress effect
 *   2. get_current_datetime, manage_todos, render_widget declare model-egress (normal)
 *   3. Declared destinations match executor resolution
 *   4. Engine auto-issues model-egress capability for none-operation normal-class actions in all modes
 */
import { describe, it, expect } from "vitest";
import { ALL_ANALYZERS } from "../action-lifecycle-factory.js";
import { PolicyEngine } from "../policy-engine.js";
import { InMemoryArtifactStore } from "../../../capabilities/execution/in-memory-artifact-store.js";
import type { ToolAnalysisContext } from "../../../foundations/contracts/custom-tools.js";
import type { PolicyContext } from "../../../foundations/contracts/permission-policy.js";
import { createSnapshotStore, tagFor } from "../../../foundations/hashline/snapshot-store.js";

import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A REAL temp workspace: edit_file's analyzer reads current file content at
// analysis time, so the patched path must exist on disk.
const MOCK_WORKSPACE = realpathSync(mkdtempSync(join(tmpdir(), "seepient-conformance-")));
writeFileSync(join(MOCK_WORKSPACE, "test.txt"), "hello\n", "utf8");

const artifacts = new InMemoryArtifactStore();

const ctx: ToolAnalysisContext = {
  principalId: "user-test",
  runId: "run-test",
  toolCallId: "call-test",
  workspace: {
    workspaceId: "ws-test",
    canonicalRoot: MOCK_WORKSPACE,
    policyVersion: 1,
    policyDigest: "digest-test",
  },
  artifacts,
  modelProviderClass: "*",
  // spec 019: edit_file's analyzer applies patches against the store.
  snapshotStore: createSnapshotStore(),
};
// The edit_file invocation below patches test.txt — the store must know it.
ctx.snapshotStore!.record("test.txt", "hello\n");

describe("analyzer conformance (spec 017, T018 / QS-3)", () => {
  it("declares model-egress effect for all output-producing built-in tools", async () => {
    const toolsToTest: Array<{ name: string; args: unknown }> = [
      { name: "read_file", args: { path: "test.txt" } },
      { name: "write_file", args: { path: "test.txt", content: "hi" } },
      { name: "edit_file", args: { patch: `[test.txt#${tagFor("test.txt", "hello\n")}]\n+hi\n` } },
      { name: "execute_shell_command", args: { command: "ls" } },
      { name: "get_current_datetime", args: {} },
      { name: "manage_todos", args: {} },
      { name: "render_widget", args: {} },
      { name: "web_search", args: { query: "search" } },
      { name: "read_website", args: { url: "https://example.com" } },
      { name: "send_email", args: { to: "a@b.com", subject: "s", body: "b" } },
      { name: "send_notification", args: { platform: "feishu", content: "c" } },
      { name: "generate_image", args: { prompt: "draw" } },
      { name: "optimize_prompt", args: { raw_prompt: "prompt" } },
    ];

    for (const tool of toolsToTest) {
      const analyzer = ALL_ANALYZERS[tool.name];
      expect(analyzer, `Analyzer for ${tool.name} must exist`).toBeDefined();
      const action = await analyzer(tool.args, ctx);
      const egress = action.effects.find((e) => e.kind === "model-egress");
      expect(
        egress,
        `Tool ${tool.name} must declare a model-egress effect for its output`,
      ).toBeDefined();
    }
  });

  it("zero-effect tools declare model-egress normal and have operation.kind === 'none'", async () => {
    const zeroEffectTools = ["get_current_datetime", "manage_todos", "render_widget"];
    for (const name of zeroEffectTools) {
      const analyzer = ALL_ANALYZERS[name];
      const action = await analyzer({}, ctx);
      expect(action.operation.kind).toBe("none");
      const egress = action.effects.find((e) => e.kind === "model-egress");
      expect(egress).toBeDefined();
      expect(egress?.dataClasses).toEqual(["normal"]);
    }
  });

  it("engine auto-issues none-operation normal-class actions even with empty activeCapabilities (FR-012)", async () => {
    const policyContext: PolicyContext = {
      deploymentCeiling: {
        version: 1,
        capabilities: [
          { kind: "model-egress", providerClass: "*", dataClasses: ["normal", "sensitive"] },
        ],
      },
      principalPolicy: { version: 1, capabilities: [] },
      runtimeBaseline: { version: 1, capabilities: [] },
      activeCapabilities: { version: 1, capabilities: [] }, // caller supplied empty activeCapabilities!
      immutableDenies: [],
      approvalMode: "manual",
      interaction: { mode: "inline" },
      backendCapabilities: {
        backend: "local-native",
        capabilityKinds: ["model-egress"],
        exactCommit: true,
        hostFilteredEgress: true,
        environmentIsolation: true,
        supportedOperationKinds: ["none"],
      },
    };

    const engine = new PolicyEngine("digest-test");
    const analyzer = ALL_ANALYZERS["get_current_datetime"];
    const action = await analyzer({}, ctx);

    const decision = engine.evaluate(action, policyContext);
    expect(decision.decision).toBe("allow");
    if (decision.decision === "allow") {
      expect(decision.envelope.capabilities).toContainEqual({
        kind: "model-egress",
        providerClass: "*",
        dataClasses: ["normal"],
      });
    }
  });
});
