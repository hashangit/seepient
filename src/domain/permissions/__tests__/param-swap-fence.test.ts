import { describe, expect, it } from "vitest";
import { makeRegistrationAnalyzer } from "../registration-dispatch.js";
import { resolveAnalyzerWithFallback } from "../default-analyzers.js";
import type { ToolAnalysisContext } from "../../../foundations/contracts/custom-tools.js";
import type { TrustedHostToolRegistration } from "../../../foundations/contracts/custom-tools.js";

function registration(declaration?: {
  risk?: "safe" | "edit" | "communications" | "destructive";
}): TrustedHostToolRegistration {
  return {
    trust: "host",
    definition: {
      type: "function",
      function: {
        name: "app_demo_op",
        description: "demo",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    ...(declaration ? { declaration } : {}),
    execute: async () => "ok",
  } as unknown as TrustedHostToolRegistration;
}

const ctx = (overrides: Partial<ToolAnalysisContext> = {}): ToolAnalysisContext =>
  ({
    principalId: "p1",
    runId: "run-1",
    toolCallId: "tc-1",
    modelProviderClass: "normal",
    ...overrides,
  }) as unknown as ToolAnalysisContext;

describe("FR-010 param-swap fence (analysis→execution)", () => {
  it("registration analyzer: post-analysis mutation of the caller's args object does not alter the prepared operation", async () => {
    const analyzer = makeRegistrationAnalyzer(registration({ risk: "edit" }));
    const args = { target: "memory-key-a", revision: 1 };
    const action = await analyzer(args, ctx());
    if (action.operation.kind !== "trusted-host") {
      throw new Error("expected a trusted-host prepared operation");
    }
    const before = JSON.stringify(action.operation.args);
    // A caller (or a races writer) mutates the original after analysis.
    args.target = "memory-key-HIJACKED";
    args.revision = 99;
    expect(JSON.stringify(action.operation.args)).toBe(before);
    expect((action.operation.args as { target: string }).target).toBe("memory-key-a");
  });

  it("fallback analyzer: same freeze for tools without a dedicated analyzer", async () => {
    const analyzer = resolveAnalyzerWithFallback({}, "app_other");
    const args = { path: "/home/a" };
    const action = await analyzer(args, ctx());
    if (action.operation.kind !== "trusted-host") {
      throw new Error("expected a trusted-host prepared operation");
    }
    (args as { path: string }).path = "/etc/passwd";
    expect((action.operation.args as { path: string }).path).toBe("/home/a");
  });
});
