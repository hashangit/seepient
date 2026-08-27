/**
 * Mode decision matrix tests (spec 017, T024 / T032 / T033 / QS-4).
 *
 * Tests every cell of the Mode Decision Matrix in data-model.md:
 *   - ask-everything (manual)
 *   - edit-enabled (balanced)
 *   - autonomous (autonomous)
 *   - Live mode toggling without restart
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { PolicyEngine } from "../policy-engine.js";
import { ALL_ANALYZERS } from "../action-lifecycle-factory.js";
import { InMemoryArtifactStore } from "../../../capabilities/execution/in-memory-artifact-store.js";
import type { PolicyContext } from "../../../foundations/contracts/permission-policy.js";
import type { ToolAnalysisContext } from "../../../foundations/contracts/custom-tools.js";

describe("consent mode matrix (spec 017, T024 / T032 / T033 / QS-4)", () => {
  let tempDir: string;
  let workspaceRoot: string;
  let artifacts: InMemoryArtifactStore;
  let engine: PolicyEngine;
  let ctx: ToolAnalysisContext;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "seepient-matrix-"));
    workspaceRoot = path.join(tempDir, "workspace");
    await fs.mkdir(workspaceRoot, { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "normal.txt"), "normal content\n", "utf8");
    await fs.writeFile(path.join(workspaceRoot, ".env"), "SECRET_KEY=123\n", "utf8");
    artifacts = new InMemoryArtifactStore();
    engine = new PolicyEngine("matrix-digest");
    ctx = {
      principalId: "user-matrix",
      runId: "run-matrix",
      toolCallId: "call-matrix",
      workspace: {
        workspaceId: "ws-matrix",
        canonicalRoot: workspaceRoot,
        policyVersion: 1,
        policyDigest: "matrix-digest",
      },
      artifacts,
      modelProviderClass: "*",
    };
  });

  function makeContext(
    approvalMode: "manual" | "balanced" | "autonomous",
    opts?: { environmentIsolation?: boolean },
  ): PolicyContext {
    return {
      deploymentCeiling: {
        version: 1,
        capabilities: [
          { kind: "read-root", root: workspaceRoot },
          { kind: "write-root", root: workspaceRoot },
          { kind: "process" },
          { kind: "model-egress", providerClass: "*", dataClasses: ["normal", "sensitive", "secret"] },
          { kind: "network-destination", scheme: "https", host: "*" },
          { kind: "external-recipient", service: "*", recipient: "*" },
          { kind: "secret-ref", ref: "*" },
        ],
      },
      principalPolicy: {
        version: 1,
        capabilities: [
          { kind: "read-root", root: workspaceRoot },
          { kind: "model-egress", providerClass: "*", dataClasses: ["normal"] },
        ],
      },
      runtimeBaseline: {
        version: 1,
        capabilities: [
          { kind: "read-root", root: workspaceRoot },
          { kind: "write-root", root: workspaceRoot },
          { kind: "process" },
          { kind: "model-egress", providerClass: "*", dataClasses: ["normal", "sensitive", "secret"] },
          { kind: "network-destination", scheme: "https", host: "*" },
          { kind: "external-recipient", service: "*", recipient: "*" },
          { kind: "secret-ref", ref: "*" },
        ],
      },
      activeCapabilities: {
        version: 1,
        capabilities: [
          { kind: "read-root", root: workspaceRoot },
          { kind: "model-egress", providerClass: "*", dataClasses: ["normal"] },
        ],
      },
      immutableDenies: [],
      approvalMode,
      interaction: { mode: "inline" },
      backendCapabilities: {
        backend: "local-native",
        capabilityKinds: [
          "read-root",
          "read-file",
          "write-root",
          "commit-file",
          "process",
          "model-egress",
          "network-destination",
          "external-recipient",
          "secret-ref",
          "trusted-host",
        ],
        exactCommit: true,
        hostFilteredEgress: true,
        environmentIsolation: opts?.environmentIsolation ?? true,
        supportedOperationKinds: ["none", "read-file", "commit-files", "process", "broker", "trusted-host"],
      },
      workspaceRoot,
    };
  }

  describe("ask-everything (approvalMode: manual)", () => {
    const pCtx = () => makeContext("manual");

    it("evaluates actions according to manual column", async () => {
      const p = pCtx();

      // Zero effect / always allowed
      const dt = await ALL_ANALYZERS.get_current_datetime({}, ctx);
      expect(engine.evaluate(dt, p).decision).toBe("allow");

      // Read normal file
      const readNormal = await ALL_ANALYZERS.read_file({ path: "normal.txt" }, ctx);
      expect(engine.evaluate(readNormal, p).decision).toBe("allow");

      // Read secret file (.env)
      const readSecret = await ALL_ANALYZERS.read_file({ path: ".env" }, ctx);
      expect(engine.evaluate(readSecret, p).decision).toBe("needs-approval");

      // Write / edit in workspace
      const write = await ALL_ANALYZERS.write_file({ path: "out.txt", content: "data" }, ctx);
      expect(engine.evaluate(write, p).decision).toBe("needs-approval");

      // Shell
      const shellSafe = await ALL_ANALYZERS.execute_shell_command({ command: "ls" }, ctx);
      expect(engine.evaluate(shellSafe, p).decision).toBe("needs-approval");

      // Brokered
      const webSearch = await ALL_ANALYZERS.web_search({ query: "q" }, ctx);
      expect(engine.evaluate(webSearch, p).decision).toBe("needs-approval");

      const readWeb = await ALL_ANALYZERS.read_website({ url: "https://example.com" }, ctx);
      expect(engine.evaluate(readWeb, p).decision).toBe("needs-approval");

      const email = await ALL_ANALYZERS.send_email({ to: "a@b.com", subject: "s", body: "b" }, ctx);
      expect(engine.evaluate(email, p).decision).toBe("needs-approval");
    });
  });

  describe("edit-enabled (approvalMode: balanced)", () => {
    const pCtx = () => makeContext("balanced");

    it("auto-issues non-destructive, non-send in-ceiling actions and routes destructive/sends to prompt", async () => {
      const p = pCtx();

      // Zero effect
      const dt = await ALL_ANALYZERS.get_current_datetime({}, ctx);
      expect(engine.evaluate(dt, p).decision).toBe("allow");

      // Read normal file
      const readNormal = await ALL_ANALYZERS.read_file({ path: "normal.txt" }, ctx);
      expect(engine.evaluate(readNormal, p).decision).toBe("allow");

      // Read secret file (.env) routes to prompt
      const readSecret = await ALL_ANALYZERS.read_file({ path: ".env" }, ctx);
      expect(engine.evaluate(readSecret, p).decision).toBe("needs-approval");

      // Write / edit inside workspace auto-approves
      const write = await ALL_ANALYZERS.write_file({ path: "out.txt", content: "data" }, ctx);
      expect(engine.evaluate(write, p).decision).toBe("allow");

      const edit = await ALL_ANALYZERS.edit_file(
        { patch: "[normal.txt#0000]\n+updated" },
        ctx,
      );
      expect(engine.evaluate(edit, p).decision).toBe("allow");

      // Shell safe auto-approves
      const shellSafe = await ALL_ANALYZERS.execute_shell_command({ command: "ls" }, ctx);
      expect(engine.evaluate(shellSafe, p).decision).toBe("allow");

      // Shell destructive routes to prompt
      const shellDestructive = await ALL_ANALYZERS.execute_shell_command(
        { command: "rm -rf /tmp/test" },
        ctx,
      );
      expect(engine.evaluate(shellDestructive, p).decision).toBe("needs-approval");

      // Web search & read website auto-approve
      const webSearch = await ALL_ANALYZERS.web_search({ query: "q" }, ctx);
      expect(engine.evaluate(webSearch, p).decision).toBe("allow");

      const readWeb = await ALL_ANALYZERS.read_website({ url: "https://example.com" }, ctx);
      expect(engine.evaluate(readWeb, p).decision).toBe("allow");

      // generate_image & optimize_prompt auto-approve
      const img = await ALL_ANALYZERS.generate_image({ prompt: "art" }, ctx);
      expect(engine.evaluate(img, p).decision).toBe("allow");

      const opt = await ALL_ANALYZERS.optimize_prompt({ raw_prompt: "prompt" }, ctx);
      expect(engine.evaluate(opt, p).decision).toBe("allow");

      // Sends route to prompt
      const email = await ALL_ANALYZERS.send_email({ to: "a@b.com", subject: "s", body: "b" }, ctx);
      expect(engine.evaluate(email, p).decision).toBe("needs-approval");

      const notify = await ALL_ANALYZERS.send_notification({ platform: "feishu", content: "hi" }, ctx);
      expect(engine.evaluate(notify, p).decision).toBe("needs-approval");
    });
  });

  describe("autonomous (approvalMode: autonomous)", () => {
    const pCtx = () => makeContext("autonomous");

    it("auto-issues all in-ceiling capabilities with zero prompts (T033)", async () => {
      const p = pCtx();

      const actions = [
        await ALL_ANALYZERS.read_file({ path: ".env" }, ctx),
        await ALL_ANALYZERS.write_file({ path: "out.txt", content: "c" }, ctx),
        await ALL_ANALYZERS.execute_shell_command({ command: "rm -rf /tmp/test" }, ctx),
        await ALL_ANALYZERS.web_search({ query: "q" }, ctx),
        await ALL_ANALYZERS.read_website({ url: "https://example.com" }, ctx),
        await ALL_ANALYZERS.generate_image({ prompt: "art" }, ctx),
        await ALL_ANALYZERS.optimize_prompt({ raw_prompt: "prompt" }, ctx),
        await ALL_ANALYZERS.send_email({ to: "a@b.com", subject: "s", body: "b" }, ctx),
        await ALL_ANALYZERS.send_notification({ platform: "feishu", content: "hi" }, ctx),
      ];

      for (const action of actions) {
        const decision = engine.evaluate(action, p);
        expect(decision.decision, `Action ${action.toolName} must be allow in autonomous mode`).toBe("allow");
      }
    });
  });

  describe("live mode toggling (T032)", () => {
    it("immediately changes the next decision when approvalMode is switched", async () => {
      const p = makeContext("manual");
      const write = await ALL_ANALYZERS.write_file({ path: "out.txt", content: "c" }, ctx);

      // In manual -> needs-approval
      expect(engine.evaluate(write, p).decision).toBe("needs-approval");

      // Switch to balanced -> allow
      p.approvalMode = "balanced";
      expect(engine.evaluate(write, p).decision).toBe("allow");

      // Switch back to manual -> needs-approval
      p.approvalMode = "manual";
      expect(engine.evaluate(write, p).decision).toBe("needs-approval");

      // Switch to autonomous -> allow
      p.approvalMode = "autonomous";
      expect(engine.evaluate(write, p).decision).toBe("allow");
    });
  });
});
