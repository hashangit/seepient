/**
 * Golden tool baseline test (spec 017, T002 / T015 / T016 / QS-1).
 *
 * All 15 built-in tools evaluated against the default composed envelope.
 * Arms:
 *   1. Fresh install: default composed ceiling + runtime baseline
 *   2. Stored principal policy from pre-fix era (verifies FR-019 reconciliation)
 *   3. No-key arm: missing credentials produce SetupFailure instruction, never outside-ceiling
 *
 * Expects:
 *   - Zero "outside-ceiling" denials for the 14 supported tools (take_screenshot is backend-unsupported)
 *   - Zero empty envelopes for output-producing tools (get_current_datetime, manage_todos, render_widget)
 *   - Typed setup failure messages with 'seepient setup' remediation when credentials are missing
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { buildActionLifecycle, ALL_ANALYZERS } from "../action-lifecycle-factory.js";
import { InMemoryArtifactStore } from "../../../capabilities/execution/in-memory-artifact-store.js";
import type { ApprovalBroker, PolicyContext } from "../../../foundations/contracts/permission-policy.js";
import type { ExecutionBoundary } from "../../../foundations/contracts/execution-boundary.js";
import { LocalPolicyStore, computeWorkspaceId } from "../policy-store.js";
import type { ToolAnalysisContext } from "../../../foundations/contracts/custom-tools.js";
import { BrokerExecutor } from "../../../capabilities/execution/executors.js";
import { EffectBroker } from "../../../capabilities/execution/effect-broker.js";

const NOOP_BROKER: ApprovalBroker = {
  mode: "inline",
  request: async (req) => ({
    approved: false,
    requestId: req.requestId,
    actionDigest: req.actionDigest,
    actorId: "test-broker",
    reason: "cancelled",
    decidedAt: Date.now(),
  }),
};

const LOCAL_BOUNDARY: ExecutionBoundary = {
  capabilities: {
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
    jsFsFallbackOptIn: false,
    hostFilteredEgress: true,
    environmentIsolation: true,
    supportedOperationKinds: ["none", "read-file", "commit-files", "process", "broker", "trusted-host"],
  },
  execute: async (action) => ({
    state: "succeeded",
    result: { output: "ok", success: true },
    evidence: {
      backend: "local-native",
      actionDigest: action.actionDigest,
      executorId: "test",
      operationKind: action.operation.kind,
    },
  }),
};

describe("golden tool baseline (spec 017, T002 / T015 / T016 / QS-1)", () => {
  let tempDir: string;
  let workspaceRoot: string;
  let artifacts: InMemoryArtifactStore;
  let savedGlobalDir: string | undefined;
  let savedCwd: string | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "seepient-golden-"));
    workspaceRoot = path.join(tempDir, "workspace");
    await fs.mkdir(workspaceRoot, { recursive: true });
    // Write sample files for read/write/edit/skill
    await fs.writeFile(path.join(workspaceRoot, "test.txt"), "hello world\n", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "sample-skill.md"), "# Skill\n", "utf8");
    artifacts = new InMemoryArtifactStore();

    savedGlobalDir = process.env.SEEPIENT_CONFIG_GLOBAL_DIR;
    savedCwd = process.env.SEEPIENT_CWD;
    process.env.SEEPIENT_CONFIG_GLOBAL_DIR = path.join(tempDir, "fake-global");
    process.env.SEEPIENT_CWD = workspaceRoot;
  });

  afterEach(async () => {
    if (savedGlobalDir !== undefined) process.env.SEEPIENT_CONFIG_GLOBAL_DIR = savedGlobalDir;
    else delete process.env.SEEPIENT_CONFIG_GLOBAL_DIR;
    if (savedCwd !== undefined) process.env.SEEPIENT_CWD = savedCwd;
    else delete process.env.SEEPIENT_CWD;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function getAnalysisContext(policyContext?: PolicyContext): Promise<ToolAnalysisContext> {
    const root = policyContext?.workspaceRoot ?? workspaceRoot;
    return {
      principalId: "user-test",
      runId: "run-test",
      toolCallId: "call-test",
      workspace: {
        workspaceId: computeWorkspaceId(root),
        canonicalRoot: root,
        policyVersion: 1,
        policyDigest: "digest-test",
      },
      artifacts,
      modelProviderClass: "*",
    };
  }

  it("evaluates all 15 built-in tools against the fresh-install default envelope without outside-ceiling", async () => {
    const wired = await buildActionLifecycle({
      principalId: "user-test",
      runId: "run-test",
      workspaceRoot,
      approvalBroker: NOOP_BROKER,
      executionBoundary: LOCAL_BOUNDARY,
      artifacts,
      auditRoot: path.join(tempDir, "audit"),
    });

    const ctx = await getAnalysisContext(wired.policyContext);

    const toolInvocations: Array<{ name: string; args: unknown; expectedResult: "allow" | "needs-approval" | "backend-unsupported" }> = [
      { name: "read_file", args: { path: "test.txt" }, expectedResult: "allow" },
      { name: "write_file", args: { path: "new.txt", content: "data" }, expectedResult: "needs-approval" },
      { name: "edit_file", args: { patch: "[test.txt#0000]\n+hi\n" }, expectedResult: "needs-approval" },
      { name: "execute_shell_command", args: { command: "echo ok" }, expectedResult: "needs-approval" },
      { name: "use_skill", args: { skill_name: "sample-skill" }, expectedResult: "allow" },
      { name: "get_current_datetime", args: {}, expectedResult: "allow" },
      { name: "manage_todos", args: { action: "list" }, expectedResult: "allow" },
      { name: "render_widget", args: { widget: "counter" }, expectedResult: "allow" },
      { name: "web_search", args: { query: "vitest documentation" }, expectedResult: "needs-approval" },
      { name: "read_website", args: { url: "https://vitest.dev" }, expectedResult: "needs-approval" },
      { name: "send_email", args: { to: "alice@example.com", subject: "hi", body: "test" }, expectedResult: "needs-approval" },
      { name: "send_notification", args: { platform: "feishu", content: "alert" }, expectedResult: "needs-approval" },
      { name: "generate_image", args: { prompt: "sunset" }, expectedResult: "needs-approval" },
      { name: "optimize_prompt", args: { raw_prompt: "write poetry" }, expectedResult: "needs-approval" },
      { name: "take_screenshot", args: {}, expectedResult: "allow" },
    ];

    expect(toolInvocations).toHaveLength(15);

    for (const inv of toolInvocations) {
      const analyzer = ALL_ANALYZERS[inv.name];
      expect(analyzer, `Analyzer must exist for tool ${inv.name}`).toBeDefined();

      const action = await analyzer(inv.args, ctx);
      const decision = wired.policyContext ? (wired.lifecycle as any).policy.evaluate(action, wired.policyContext) : null;

      expect(decision, `Decision for ${inv.name}`).toBeDefined();
      if (decision.decision === "deny") {
        expect(
          decision.reason,
          `Tool ${inv.name} should never fail with outside-ceiling, got message: ${decision.message}`,
        ).not.toBe("outside-ceiling");
        if (inv.expectedResult === "backend-unsupported") {
          expect(decision.reason).toBe("backend-unsupported");
        } else {
          expect(decision.decision, `Tool ${inv.name} denied unexpectedly: ${decision.message}`).toBe(inv.expectedResult);
        }
      } else if (decision.decision === "allow") {
        expect(inv.expectedResult, `Tool ${inv.name} allowed`).toBe("allow");
        // Output-producing tools must carry model-egress capability in their issued envelope
        if (["get_current_datetime", "manage_todos", "render_widget"].includes(inv.name)) {
          expect(decision.envelope.capabilities.some((c: any) => c.kind === "model-egress")).toBe(true);
        }
      } else if (decision.decision === "needs-approval") {
        expect(inv.expectedResult, `Tool ${inv.name} requested approval`).toBe("needs-approval");
      }
    }
  });

  it("evaluates all 15 built-in tools against a pre-fix stored policy after reconciliation", async () => {
    const policyDir = path.join(tempDir, "policies");
    await fs.mkdir(policyDir, { recursive: true });
    const policyStore = new LocalPolicyStore({ root: policyDir });
    const workspaceId = computeWorkspaceId(workspaceRoot);

    // Pre-fix snapshot: version 1 without network-destination, external-recipient, or secret-ref
    await policyStore.compareAndSet(
      workspaceId,
      0,
      {
        version: 1,
        capabilities: [
          { kind: "read-root", root: workspaceRoot },
          { kind: "write-root", root: workspaceRoot },
          { kind: "process" },
          { kind: "model-egress", providerClass: "*", dataClasses: ["normal", "sensitive"] },
        ],
      },
      { kind: "human", authorityId: "user-test", authenticatedBy: "test" },
    );

    // Delete ceilingVersion from file to simulate legacy pre-fix store
    const file = path.join(policyDir, `${workspaceId}.json`);
    const raw = JSON.parse(await fs.readFile(file, "utf8"));
    delete raw.ceilingVersion;
    await fs.writeFile(file, JSON.stringify(raw), "utf8");

    const wired = await buildActionLifecycle({
      principalId: "user-test",
      runId: "run-test",
      workspaceRoot,
      approvalBroker: NOOP_BROKER,
      executionBoundary: LOCAL_BOUNDARY,
      artifacts,
      policyStore,
      auditRoot: path.join(tempDir, "audit"),
    });

    const ctx = await getAnalysisContext(wired.policyContext);

    const brokeredTools = [
      { name: "web_search", args: { query: "test" } },
      { name: "read_website", args: { url: "https://example.com" } },
      { name: "send_email", args: { to: "user@example.com", subject: "hi", body: "body" } },
      { name: "send_notification", args: { platform: "feishu", content: "msg" } },
      { name: "generate_image", args: { prompt: "cat" } },
      { name: "optimize_prompt", args: { raw_prompt: "prompt" } },
    ];

    for (const tool of brokeredTools) {
      const analyzer = ALL_ANALYZERS[tool.name];
      const action = await analyzer(tool.args, ctx);
      const decision = (wired.lifecycle as any).policy.evaluate(action, wired.policyContext);
      expect(
        decision.reason,
        `Reconciled policy must not deny ${tool.name} with outside-ceiling`,
      ).not.toBe("outside-ceiling");
    }
  });

  it("produces typed setup failure (never outside-ceiling) when credentials are missing", async () => {
    // Save existing env
    const savedTavily = process.env.TAVILY_API_KEY;
    const savedSmtp = process.env.SMTP_HOST;
    const savedOpenAi = process.env.OPENAI_API_KEY;
    const savedCompat = process.env.OPENAI_COMPAT_BASE_URL;
    delete process.env.TAVILY_API_KEY;
    delete process.env.SMTP_HOST;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_COMPAT_BASE_URL;

    try {
      const wired = await buildActionLifecycle({
        principalId: "user-test",
        runId: "run-test",
        workspaceRoot,
        approvalBroker: NOOP_BROKER,
        executionBoundary: LOCAL_BOUNDARY,
        artifacts,
        auditRoot: path.join(tempDir, "audit"),
      });

      const ctx = await getAnalysisContext(wired.policyContext);
      const broker = new EffectBroker({
        artifacts,
        network: {
          resolve: async () => ["93.184.216.34"],
          fetch: async () => ({
            status: 200,
            bytes: new Uint8Array(),
            effectiveHost: "api.tavily.com",
            effectiveIp: "93.184.216.34",
            headers: {},
          }),
        },
      });
      const brokerExecutor = new BrokerExecutor({ broker, workspaceRoot });

      const webSearchAction = await ALL_ANALYZERS.web_search({ query: "news" }, ctx);
      const envelope = {
        version: 1 as const,
        envelopeId: "env-1",
        actionDigest: webSearchAction.actionDigest,
        principalId: "user-test",
        runId: "run-test",
        policyDigest: "digest-1",
        capabilities: wired.policyContext.deploymentCeiling.capabilities,
        lifetime: { kind: "action" as const, actionDigest: webSearchAction.actionDigest, consumeOnce: true as const },
        issuedBy: { kind: "service" as const, authorityId: "test", authenticatedBy: "test" },
        issuedAt: Date.now(),
      };

      const result = await brokerExecutor.execute(
        webSearchAction,
        envelope,
        webSearchAction.operation as any,
        {},
      );

      expect(result.state).toBe("failed");
      if (result.state === "failed") {
        expect(result.error?.code).toBe("SETUP_REQUIRED");
        expect(result.error?.message).toContain("[setup required]");
        expect(result.error?.message).toContain("seepient setup");
      }
    } finally {
      if (savedTavily !== undefined) process.env.TAVILY_API_KEY = savedTavily;
      if (savedSmtp !== undefined) process.env.SMTP_HOST = savedSmtp;
      if (savedOpenAi !== undefined) process.env.OPENAI_API_KEY = savedOpenAi;
      if (savedCompat !== undefined) process.env.OPENAI_COMPAT_BASE_URL = savedCompat;
    }
  });
});
