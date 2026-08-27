import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { resolveCredentials } from "../../../foundations/security/credential-resolver.js";
import { deriveConfigGrants } from "../config-derived-grants.js";
import { BrokerExecutor } from "../../../capabilities/execution/executors.js";
import { PolicyEngine } from "../policy-engine.js";
import type { PreparedToolAction } from "../../../foundations/contracts/prepared-action.js";
import type { PolicyContext } from "../../../foundations/contracts/permission-policy.js";

describe("Credential resolution from settings files & preflight checks", () => {
  let tmpDir: string;
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    savedEnv = { ...process.env };
    delete process.env.TAVILY_API_KEY;
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    delete process.env.FEISHU_WEBHOOK;
    delete process.env.DINGTALK_WEBHOOK;
    delete process.env.WECOM_WEBHOOK;
    delete process.env.OPENAI_API_KEY;

    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "seepient-cred-test-"));
    process.env.SEEPIENT_CONFIG_GLOBAL_DIR = path.join(tmpDir, "fake-global");
  });

  afterEach(async () => {
    process.env = savedEnv;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("resolves settings-file credentials when environment variables are unset", async () => {
    const seepientDir = path.join(tmpDir, ".seepient");
    await fs.mkdir(seepientDir, { recursive: true });
    await fs.writeFile(
      path.join(seepientDir, "setting.json"),
      JSON.stringify({
        search: { tavilyApiKey: "tvly-from-settings-file" },
        smtpHost: "smtp.example.com",
        smtpUser: "bot@example.com",
        smtpPass: "secret-pass",
      }),
      "utf8",
    );

    const creds = resolveCredentials({}, tmpDir);
    expect(creds.tavilyApiKey).toBe("tvly-from-settings-file");
    expect(creds.smtpHost).toBe("smtp.example.com");
    expect(creds.smtpUser).toBe("bot@example.com");
    expect(creds.smtpPass).toBe("secret-pass");

    // Derived grants include Tavily and SMTP
    const grants = deriveConfigGrants({ workspaceRoot: tmpDir });
    expect(grants).toContainEqual({
      kind: "network-destination",
      scheme: "https",
      host: "api.tavily.com",
    });
    expect(grants).toContainEqual({
      kind: "secret-ref",
      ref: "tavilyApiKey",
    });
    expect(grants).toContainEqual({
      kind: "secret-ref",
      ref: "smtpHost",
    });
  });

  it("BrokerExecutor preflight succeeds with settings-file credentials", async () => {
    const mockBroker: any = {
      execute: vi.fn().mockResolvedValue({ status: "succeeded", output: "art-1" }),
    };
    const executor = new BrokerExecutor({ broker: mockBroker });

    // With custom config / settings resolver returning tavilyApiKey
    process.env.TAVILY_API_KEY = "tvly-active";

    const action: PreparedToolAction = {
      version: 1,
      actionId: "act-1",
      actionDigest: "dig-1",
      toolName: "web_search",
      toolCallId: "call-1",
      argsDigest: "args-1",
      runId: "run-1",
      principalId: "user-1",
      effects: [
        { kind: "network-egress", destinations: [{ scheme: "https", host: "api.tavily.com" }] },
        { kind: "secret-use", secretRefs: ["tavilyApiKey"] },
      ],
      operation: {
        kind: "broker",
        request: {
          kind: "http",
          requestId: "req-1",
          method: "POST",
          destination: { scheme: "https", host: "api.tavily.com" },
          headers: {},
          secretRefs: ["tavilyApiKey"],
        },
      },
      display: { title: "Web search", summary: "query", canonicalTargets: [], effects: [] },
      risk: "safe",
    };

    const envelope: any = {
      actionDigest: "dig-1",
      capabilities: [
        { kind: "network-destination", scheme: "https", host: "api.tavily.com" },
        { kind: "secret-ref", ref: "tavilyApiKey" },
      ],
    };

    const result = await executor.execute(action, envelope, action.operation as any, {});

    expect(result.state).toBe("succeeded");
  });
});

describe("PolicyEngine FR-012 none-op deployment ceiling enforcement (P1-1)", () => {
  it("denies none-op tools with outside-ceiling when deployment ceiling omits model-egress", () => {
    const engine = new PolicyEngine("pol-test-1");

    const noneOpAction: PreparedToolAction = {
      version: 1,
      actionId: "act-datetime-1",
      actionDigest: "dig-datetime-1",
      toolName: "get_current_datetime",
      toolCallId: "call-1",
      argsDigest: "args-1",
      runId: "run-1",
      principalId: "user-1",
      effects: [
        {
          kind: "model-egress",
          providerClass: "openai",
          dataClasses: ["normal"],
          sources: ["datetime"],
        },
      ],
      operation: {
        kind: "none",
        result: { output: "2026-08-27T00:00:00Z", success: true },
      },
      display: { title: "Get current datetime", summary: "now", canonicalTargets: [], effects: [] },
      risk: "safe",
    };

    // Context with deployment ceiling that intentionally OMITS model-egress
    const context: PolicyContext = {
      sessionId: "sess-1",
      workspaceId: "ws-1",
      deploymentCeiling: {
        version: 1,
        capabilities: [
          { kind: "read-root", root: "/tmp" }, // no model-egress in ceiling!
        ],
      },
      principalPolicy: { version: 1, capabilities: [] },
      runtimeBaseline: { version: 1, capabilities: [] },
      activeCapabilities: { version: 1, capabilities: [] },
      immutableDenies: [],
      backendCapabilities: {
        backend: "local-native",
        supportedOperationKinds: ["none", "read-file", "commit-files", "process", "broker", "trusted-host"],
        capabilityKinds: ["read-root", "write-root", "process", "model-egress", "network-destination", "secret-ref", "external-recipient"],
        environmentIsolation: true,
        exactCommit: true,
        hostFilteredEgress: true,
      },
      approvalMode: "autonomous",
      interaction: { mode: "inline" },
    };

    const decision = engine.evaluate(noneOpAction, context);
    expect(decision.decision).toBe("deny");
    if (decision.decision === "deny") {
      expect(decision.reason).toBe("outside-ceiling");
    }
  });

  it("auto-issues and allows none-op tools across all consent modes when within deployment ceiling", () => {
    const engine = new PolicyEngine("pol-test-2");

    const noneOpAction: PreparedToolAction = {
      version: 1,
      actionId: "act-datetime-2",
      actionDigest: "dig-datetime-2",
      toolName: "get_current_datetime",
      toolCallId: "call-2",
      argsDigest: "args-2",
      runId: "run-1",
      principalId: "user-1",
      effects: [
        {
          kind: "model-egress",
          providerClass: "openai",
          dataClasses: ["normal"],
          sources: ["datetime"],
        },
      ],
      operation: {
        kind: "none",
        result: { output: "2026-08-27T00:00:00Z", success: true },
      },
      display: { title: "Get current datetime", summary: "now", canonicalTargets: [], effects: [] },
      risk: "safe",
    };

    // Standard deployment ceiling that includes model-egress
    const context: PolicyContext = {
      sessionId: "sess-1",
      workspaceId: "ws-1",
      deploymentCeiling: {
        version: 1,
        capabilities: [
          { kind: "model-egress", providerClass: "*", dataClasses: ["normal", "sensitive", "secret"] },
        ],
      },
      principalPolicy: { version: 1, capabilities: [] },
      runtimeBaseline: { version: 1, capabilities: [] },
      activeCapabilities: { version: 1, capabilities: [] }, // empty active capabilities!
      immutableDenies: [],
      backendCapabilities: {
        backend: "local-native",
        supportedOperationKinds: ["none", "read-file", "commit-files", "process", "broker", "trusted-host"],
        capabilityKinds: ["read-root", "write-root", "process", "model-egress", "network-destination", "secret-ref", "external-recipient"],
        environmentIsolation: true,
        exactCommit: true,
        hostFilteredEgress: true,
      },
      approvalMode: "manual",
      interaction: { mode: "inline" },
    };

    const decision = engine.evaluate(noneOpAction, context);
    expect(decision.decision).toBe("allow");
  });
});
