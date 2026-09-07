/**
 * Spec 022 — ToolRegistry & Scoped Tool Resolution Unit Tests (T004, T005).
 */
import { describe, it, expect } from "vitest";
import {
  ToolRegistry,
  ToolRegistrationError,
  BUILT_IN_TOOL_MODULES,
  resolveTools,
} from "../tool-executor.js";
import type { ToolModule } from "../../foundations/contracts/tool.js";

function makeTool(name: string, description = `Tool ${name}`): ToolModule {
  return {
    name,
    definition: {
      type: "function",
      function: {
        name,
        description,
        parameters: {
          type: "object",
          properties: { value: { type: "string" } },
          required: [],
        },
      },
    },
    handler: async (args: Record<string, unknown>) => ({
      success: true,
      output: `ok: ${JSON.stringify(args)}`,
    }),
  };
}

describe("ToolRegistry (T004)", () => {
  it("BUILT_IN_TOOL_MODULES is frozen and immutable", () => {
    expect(Object.isFrozen(BUILT_IN_TOOL_MODULES)).toBe(true);
    expect(() => {
      (BUILT_IN_TOOL_MODULES as any).push(makeTool("illegal"));
    }).toThrow();
  });

  it("defaults to BUILT_IN_TOOL_MODULES on construction", () => {
    const registry = new ToolRegistry();
    expect(registry.modules().length).toBe(BUILT_IN_TOOL_MODULES.length);
    expect(registry.find("read_file")).toBeDefined();
    expect(registry.find("use_skill")).toBeDefined();
  });

  it("can be constructed with custom tool modules", () => {
    const t1 = makeTool("tool_one");
    const t2 = makeTool("tool_two");
    const registry = new ToolRegistry([t1, t2]);

    expect(registry.modules().length).toBe(2);
    expect(registry.find("tool_one")).toBe(t1);
    expect(registry.find("tool_two")).toBe(t2);
    expect(registry.find("read_file")).toBeUndefined();
  });

  it("throws ToolRegistrationError (TOOL_NAME_CONFLICT) on duplicate tool name", () => {
    const registry = new ToolRegistry([]);
    const t1 = makeTool("duplicate_tool");
    const t2 = makeTool("duplicate_tool");

    registry.register(t1);

    expect(() => registry.register(t2)).toThrow(ToolRegistrationError);
    try {
      registry.register(t2);
    } catch (err: any) {
      expect(err.code).toBe("TOOL_NAME_CONFLICT");
      expect(err.retryable).toBe(false);
      expect(err.conflictingName).toBe("duplicate_tool");
      expect(err.message).toContain("duplicate_tool");
      expect(err.message).toContain("registry");
    }
  });

  it("registerMany registers all tools or fails on conflict", () => {
    const registry = new ToolRegistry([]);
    const t1 = makeTool("batch_1");
    const t2 = makeTool("batch_2");
    registry.registerMany([t1, t2]);

    expect(registry.modules().length).toBe(2);
    expect(registry.find("batch_1")).toBe(t1);
    expect(registry.find("batch_2")).toBe(t2);
  });

  it("returns snapshot copies from modules() and definitions(), not live internal references", () => {
    const registry = new ToolRegistry([]);
    const t1 = makeTool("snap_tool");
    registry.register(t1);

    const mods1 = registry.modules();
    const mods2 = registry.modules();
    expect(mods1).not.toBe(mods2);
    expect(mods1).toEqual(mods2);

    const defs1 = registry.definitions();
    const defs2 = registry.definitions();
    expect(defs1).not.toBe(defs2);
    expect(defs1).toEqual(defs2);
  });

  it("scoped find returns matching module or undefined", () => {
    const registry = new ToolRegistry([]);
    const t1 = makeTool("find_me");
    registry.register(t1);

    expect(registry.find("find_me")).toBe(t1);
    expect(registry.find("absent_tool")).toBeUndefined();
  });
});

describe("resolveTools (T005)", () => {
  it("resolves string tool references against the passed registry", () => {
    const t1 = makeTool("custom_alpha");
    const t2 = makeTool("custom_beta");
    const registry = new ToolRegistry([t1, t2]);

    const defs = resolveTools(["custom_alpha"], registry);
    expect(defs.length).toBe(1);
    expect(defs[0].function.name).toBe("custom_alpha");
  });

  it("throws with available tool list when tool is not found in the passed registry", () => {
    const t1 = makeTool("custom_alpha");
    const registry = new ToolRegistry([t1]);

    expect(() => resolveTools(["unknown_gamma"], registry)).toThrow(
      'Unknown tool "unknown_gamma". Available: custom_alpha',
    );
  });

  it("expands tool groups against the passed registry", () => {
    const registry = new ToolRegistry(); // contains built-ins
    const coreDefs = resolveTools(["core"], registry);
    expect(coreDefs.length).toBeGreaterThan(0);
    expect(coreDefs.some((d) => d.function.name === "read_file")).toBe(true);
  });

  it("handles explicit registration objects alongside string names", () => {
    const t1 = makeTool("scoped_tool");
    const registry = new ToolRegistry([t1]);

    const explicitReg = {
      id: "explicit_reg",
      definition: {
        type: "function" as const,
        function: {
          name: "explicit_tool",
          description: "explicit",
          parameters: { type: "object", properties: {} },
        },
      },
    };

    const defs = resolveTools(["scoped_tool", explicitReg as any], registry);
    expect(defs.length).toBe(2);
    expect(defs.map((d) => d.function.name)).toEqual(["scoped_tool", "explicit_tool"]);
  });
});
