import { describe, it, expect } from "vitest";
import {
  checkToolPermission,
  getToolRiskCategory,
  resolvePermissionLevel,
} from "../permission.js";
import type { ToolModule } from "../../foundations/contracts/tool.js";

// ---------------------------------------------------------------------------
// checkToolPermission — full matrix
// ---------------------------------------------------------------------------

describe("checkToolPermission", () => {
  // strict
  it("strict + safe → auto", () => {
    expect(checkToolPermission("strict", "safe")).toBe("auto");
  });
  it("strict + edit → ask", () => {
    expect(checkToolPermission("strict", "edit")).toBe("ask");
  });
  it("strict + communications → ask", () => {
    expect(checkToolPermission("strict", "communications")).toBe("ask");
  });
  it("strict + destructive → ask", () => {
    expect(checkToolPermission("strict", "destructive")).toBe("ask");
  });

  // moderate
  it("moderate + safe → auto", () => {
    expect(checkToolPermission("moderate", "safe")).toBe("auto");
  });
  it("moderate + edit → auto", () => {
    expect(checkToolPermission("moderate", "edit")).toBe("auto");
  });
  it("moderate + communications → auto", () => {
    expect(checkToolPermission("moderate", "communications")).toBe("auto");
  });
  it("moderate + destructive → ask", () => {
    expect(checkToolPermission("moderate", "destructive")).toBe("ask");
  });

  // permissive
  it("permissive + safe → auto", () => {
    expect(checkToolPermission("permissive", "safe")).toBe("auto");
  });
  it("permissive + edit → auto", () => {
    expect(checkToolPermission("permissive", "edit")).toBe("auto");
  });
  it("permissive + communications → auto", () => {
    expect(checkToolPermission("permissive", "communications")).toBe("auto");
  });
  it("permissive + destructive → auto", () => {
    expect(checkToolPermission("permissive", "destructive")).toBe("auto");
  });

  // edge cases — unknown level defaults to strict behaviour
  it("invalid level defaults to strict behaviour", () => {
    expect(checkToolPermission("unknown" as any, "safe")).toBe("auto");
    expect(checkToolPermission("unknown" as any, "edit")).toBe("ask");
  });

  // edge cases — unknown risk defaults to destructive behaviour
  it("invalid risk defaults to destructive behaviour", () => {
    expect(checkToolPermission("permissive", "unknown" as any)).toBe("auto");
    expect(checkToolPermission("strict", "unknown" as any)).toBe("ask");
  });
});

// ---------------------------------------------------------------------------
// getToolRiskCategory
// ---------------------------------------------------------------------------

describe("getToolRiskCategory", () => {
  const safeTool: ToolModule = {
    name: "Safe Tool",
    risk: "safe",
    definition: {
      type: "function",
      function: {
        name: "safe_tool",
        description: "A safe tool",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    handler: async () => "",
  };

  const noRiskTool: ToolModule = {
    name: "No Risk Tool",
    definition: {
      type: "function",
      function: {
        name: "no_risk_tool",
        description: "A tool without risk field",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    handler: async () => "",
  };

  it("tool with risk field returns that category", () => {
    expect(getToolRiskCategory("safe_tool", [safeTool])).toBe("safe");
  });

  it("tool without risk field returns destructive", () => {
    expect(getToolRiskCategory("no_risk_tool", [noRiskTool])).toBe("destructive");
  });

  it("unknown tool name returns destructive", () => {
    expect(getToolRiskCategory("nonexistent", [safeTool, noRiskTool])).toBe("destructive");
  });
});

// ---------------------------------------------------------------------------
// resolvePermissionLevel
// ---------------------------------------------------------------------------

describe("resolvePermissionLevel", () => {
  it("flag overrides env var", () => {
    expect(resolvePermissionLevel("strict", "permissive")).toBe("strict");
  });

  it("env var overrides config", () => {
    expect(resolvePermissionLevel(undefined, "strict", "permissive")).toBe("strict");
  });

  it("config overrides default", () => {
    expect(resolvePermissionLevel(undefined, undefined, "strict")).toBe("strict");
  });

  it("invalid env value falls through", () => {
    expect(resolvePermissionLevel(undefined, "bogus", "strict")).toBe("strict");
  });

  it("default is moderate", () => {
    expect(resolvePermissionLevel()).toBe("moderate");
  });
});
