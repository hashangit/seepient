import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  resolveTools,
  getAllToolDefinitions,
  registerTool,
  tool,
  executeTool,
  normalizeToolResult,
  CORE_TOOLS,
  COMM_TOOLS,
  ADVANCED_TOOLS,
  ALL_TOOLS,
} from "../tool-executor.js";
import { builtInTools } from "../../capabilities/tools/index.js";

// We test against the real built-in registry.
// registerTool is global so we must be careful not to pollute across tests.

describe("getAllToolDefinitions", () => {
  it("returns at least the core tools", () => {
    const defs = getAllToolDefinitions();
    const names = defs.map((d) => d.function.name);
    for (const name of CORE_TOOLS) {
      expect(names).toContain(name);
    }
  });
});

describe("resolveTools", () => {
  it("defaults to all built-in tools", () => {
    const defs = resolveTools();
    const names = defs.map((d) => d.function.name);
    // Should contain at least the core tools
    for (const name of CORE_TOOLS) {
      expect(names).toContain(name);
    }
  });

  it('expands "core" group', () => {
    const defs = resolveTools(["core"]);
    const names = defs.map((d) => d.function.name);
    expect(names).toEqual(expect.arrayContaining(CORE_TOOLS));
    // Should not contain comm or advanced tools
    for (const name of COMM_TOOLS) {
      expect(names).not.toContain(name);
    }
  });

  it('expands "comm" group', () => {
    const defs = resolveTools(["comm"]);
    const names = defs.map((d) => d.function.name);
    expect(names).toEqual(expect.arrayContaining(COMM_TOOLS));
  });

  it('expands "advanced" group', () => {
    const defs = resolveTools(["advanced"]);
    const names = defs.map((d) => d.function.name);
    expect(names).toEqual(expect.arrayContaining(ADVANCED_TOOLS));
  });

  it("deduplicates when same tool appears in multiple groups", () => {
    const defs = resolveTools(["core", "all"]);
    const names = defs.map((d) => d.function.name);
    const unique = new Set(names);
    expect(names.length).toBe(unique.size);
  });

  it("resolves individual built-in tool by name", () => {
    const defs = resolveTools(["read_file"]);
    const names = defs.map((d) => d.function.name);
    expect(names).toEqual(["read_file"]);
  });

  it("throws on unknown tool name", () => {
    expect(() => resolveTools(["nonexistent_tool"])).toThrow('Unknown tool "nonexistent_tool"');
  });

  it("converts UserToolDefinition via factory", () => {
    const defs = resolveTools([
      {
        description: "custom tool",
        parameters: { type: "object", properties: { x: { type: "string" } } },
        execute: vi.fn().mockResolvedValue("ok"),
      },
    ]);
    expect(defs).toHaveLength(1);
    expect(defs[0].function.description).toBe("custom tool");
    // Auto-generated name starts with "custom_tool_"
    expect(defs[0].function.name).toMatch(/^custom_tool_\d+$/);
  });

  it("uses provided name from UserToolDefinition", () => {
    const defs = resolveTools([
      {
        name: "my_tool",
        description: "named tool",
        parameters: { type: "object", properties: {} },
        execute: vi.fn().mockResolvedValue("ok"),
      },
    ]);
    expect(defs[0].function.name).toBe("my_tool");
  });
});

describe("tool() factory", () => {
  it("creates a ToolModule with correct definition shape", () => {
    const mod = tool({
      name: "greeter",
      description: "Says hi",
      parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      execute: async (args) => `Hello, ${(args as { name: string }).name}!`,
    });

    expect(mod.name).toBe("greeter");
    expect(mod.definition.type).toBe("function");
    expect(mod.definition.function.name).toBe("greeter");
    expect(mod.definition.function.description).toBe("Says hi");
  });

  it("handler refuses to execute legacy tool({ execute }) and returns LEGACY_TOOL_DENIED", async () => {
    const mod = tool({
      name: "echo",
      description: "echo",
      parameters: { type: "object", properties: {} },
      execute: async () => "pong",
    });
    const result = await mod.handler({}, undefined);
    expect(typeof result).toBe("object");
    if (typeof result === "object" && result !== null && "error" in result) {
      expect((result as any).error.code).toBe("LEGACY_TOOL_DENIED");
      expect((result as any).output).toContain("LEGACY_TOOL_DENIED");
    }
  });

  it("executeTool normalizes a string-returning handler to a ToolResult", async () => {
    registerTool({
      name: "str-handler",
      risk: "safe",
      definition: { type: "function", function: { name: "str-handler-t051", description: "x", parameters: { type: "object", properties: {}, required: [] } } },
      handler: async () => "hello",
    });
    const result = await executeTool("str-handler-t051", {});
    expect(result).toEqual({ output: "hello", success: true });
  });
});

describe("normalizeToolResult", () => {
  it("wraps a bare string", () => {
    expect(normalizeToolResult("done")).toEqual({ output: "done", success: true });
  });

  it("passes a ToolResult through with metadata preserved", () => {
    const tr = { output: "ok", success: true, metadata: { a: 1 } };
    expect(normalizeToolResult(tr)).toBe(tr);
  });

  it("coerces an unexpected return to a string output", () => {
    expect(normalizeToolResult(42 as any)).toEqual({ output: "42", success: true });
  });
});

describe("registerTool", () => {
  it("adds a tool to the registry", () => {
    const mod = tool({
      name: "test-register-tool",
      description: "test",
      parameters: { type: "object", properties: {} },
      execute: async () => "ok",
    });
    registerTool(mod);

    const defs = getAllToolDefinitions();
    const names = defs.map((d) => d.function.name);
    expect(names).toContain("test-register-tool");
  });
});

describe("tool groups", () => {
  it("CORE_TOOLS contains expected values", () => {
    expect(CORE_TOOLS).toContain("execute_shell_command");
    expect(CORE_TOOLS).toContain("read_file");
    expect(CORE_TOOLS).toContain("write_file");
    expect(CORE_TOOLS).toContain("get_current_datetime");
  });

  it("ALL_TOOLS is union of all groups", () => {
    const expected = [...CORE_TOOLS, ...COMM_TOOLS, ...ADVANCED_TOOLS];
    expect(ALL_TOOLS).toEqual(expected);
  });
});

describe("tool risk metadata", () => {
  it("built-in tools have optional risk field on ToolModule", () => {
    for (const mod of builtInTools) {
      // risk is optional — when present it must be a valid category
      if (mod.risk !== undefined) {
        expect(["safe", "edit", "communications", "destructive"]).toContain(mod.risk);
      }
    }
  });

  it("ToolDefinition does not include risk in wire format", () => {
    const defs = getAllToolDefinitions();
    for (const def of defs) {
      expect((def as any).risk).toBeUndefined();
    }
  });

  it("custom tool without risk defaults to undefined", () => {
    const customMod = tool({
      name: "custom_no_risk",
      description: "test",
      parameters: { type: "object", properties: {} },
      execute: async () => "ok",
    });
    expect(customMod.risk).toBeUndefined();
  });
});
