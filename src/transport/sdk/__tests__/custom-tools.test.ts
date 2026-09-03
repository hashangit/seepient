/**
 * P3 custom-tool registration tests (spec 008, T304, QS-3.6).
 *
 * Verifies: preparedTool requires trust:analyzer, brokerConnector is data-only,
 * trustedHostTool is audit-labelled and disabled in server roots without an
 * operator allowlist, and legacy tool() fails closed with a deprecation warning.
 */
import { describe, it, expect, vi } from "vitest";
import {
  preparedTool,
  brokerConnector,
  trustedHostTool,
  classifyLegacyTool,
  isHostToolPermitted,
} from "../custom-tools.js";

describe("custom-tool registration (T304, QS-3.6)", () => {
  it("preparedTool emits trust:analyzer", () => {
    const reg = preparedTool({
      definition: { type: "function", function: { name: "p1", description: "d", parameters: { type: "object", properties: {}, required: [] } } },
      allowedOperationKinds: ["commit-files"],
      async analyze() {
        const target = {
          canonicalPath: "/workspace/out.txt",
          canonicalParent: "/workspace",
          basename: "out.txt",
          exists: false,
          finalSymlink: false,
        };
        return {
          operation: {
            kind: "commit-files" as const,
            commits: [
              {
                destination: target,
                content: { artifactId: "art-1", byteLength: 10, mediaType: "text/plain", sha256: "sha256:1234" },
              },
            ],
          },
          effects: [{ kind: "filesystem-write" as const, targets: [{ target, mode: "create" }] }],
          risk: "edit" as const,
          display: { title: "p1", summary: "d", canonicalTargets: [target.canonicalPath], effects: ["filesystem-write" as const] },
        };
      },
    });
    expect(reg.kind).toBe("prepared");
    expect(reg.trust).toBe("analyzer");
  });

  it("brokerConnector is data-only (no execute callback)", () => {
    const reg = brokerConnector({
      definition: { type: "function", function: { name: "b1", description: "d", parameters: { type: "object", properties: {}, required: [] } } },
      connector: "tavily",
      mapping: {
        version: 1,
        operation: "search",
        argumentBindings: { query: "/query" },
      },
    });
    expect(reg.kind).toBe("broker-connector");
    expect("execute" in reg).toBe(false);
  });

  it("trustedHostTool emits trust:host", () => {
    const reg = trustedHostTool({
      definition: { type: "function", function: { name: "h1", description: "d", parameters: { type: "object", properties: {}, required: [] } } },
      async execute() {
        return "ok";
      },
    });
    expect(reg.trust).toBe("host");
  });

  it("host tools are disabled by default in server roots", () => {
    const reg = trustedHostTool({
      definition: { type: "function", function: { name: "h1", description: "d", parameters: { type: "object", properties: {}, required: [] } } },
      async execute() {
        return "ok";
      },
    });
    expect(isHostToolPermitted(reg, { deployment: "server" })).toBe(false);
    expect(
      isHostToolPermitted(reg, {
        deployment: "server",
        allowlist: new Set(["h1"]),
      }),
    ).toBe(true);
    expect(isHostToolPermitted(reg, { deployment: "local" })).toBe(true);
  });

  it("legacy tool() emits deprecation warning and fails-closed label", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const reg = classifyLegacyTool({
      name: "legacy_thing",
      description: "d",
      parameters: {},
      async execute() {
        return "x";
      },
    });
    expect(reg.trust).toBe("legacy-host");
    expect(warn).toHaveBeenCalled();
    expect((warn.mock.calls[0][0] as string)).toContain("DEPRECATION");
    warn.mockRestore();
  });

  it("legacy tool() can never satisfy an enforced-tool (trusted-host) type", () => {
    // Legacy registrations are a separate variant; they cannot be passed
    // where a TrustedHostToolRegistration is expected without explicit
    // migration. This is a structural guarantee: the trust discriminator
    // differs ("legacy-host" vs "host").
    const legacy = classifyLegacyTool({
      description: "d",
      parameters: {},
      async execute() {
        return "x";
      },
    });
    expect(legacy.trust).not.toBe("host");
    expect(legacy.trust).toBe("legacy-host");
  });

  it("trustedHostTool accepts optional static declaration and preserves it", () => {
    const reg = trustedHostTool({
      definition: {
        type: "function",
        function: { name: "declared_tool", description: "d", parameters: { type: "object", properties: {}, required: [] } },
      },
      declaration: {
        risk: "safe",
        effects: [{ kind: "host-callback", toolName: "declared_tool" }],
        display: { title: "Declared Tool", summary: "Runs safe logic" },
      },
      async execute() {
        return "ok";
      },
    });

    expect(reg.declaration).toBeDefined();
    expect(reg.declaration?.risk).toBe("safe");
    expect(reg.declaration?.display?.title).toBe("Declared Tool");
  });

  it("makeRegistrationAnalyzer honors trustedHostTool declaration and fails closed on invalid risk", async () => {
    const { makeRegistrationAnalyzer } = await import("../../../domain/permissions/registration-dispatch.js");

    const validReg = trustedHostTool({
      definition: {
        type: "function",
        function: { name: "safe_tool", description: "d", parameters: { type: "object", properties: {}, required: [] } },
      },
      declaration: {
        risk: "safe",
        display: { title: "Safe Tool" },
      },
      async execute() {
        return "ok";
      },
    });

    const analyzer = makeRegistrationAnalyzer(validReg);
    const mockCtx: any = {
      principalId: "user-1",
      runId: "run-1",
      toolCallId: "call-1",
      modelProviderClass: "openai",
    };

    const action = await analyzer({}, mockCtx);
    expect(action.risk).toBe("safe");
    expect(action.display.title).toBe("Safe Tool");

    // Invalid risk category fails closed
    const invalidReg = trustedHostTool({
      definition: {
        type: "function",
        function: { name: "invalid_tool", description: "d", parameters: { type: "object", properties: {}, required: [] } },
      },
      declaration: {
        risk: "ultra-high" as any,
      },
      async execute() {
        return "ok";
      },
    });

    const badAnalyzer = makeRegistrationAnalyzer(invalidReg);
    await expect(badAnalyzer({}, mockCtx)).rejects.toThrow('Invalid risk category "ultra-high"');
  });
});
