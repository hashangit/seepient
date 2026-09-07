/**
 * Spec 022 — SDK Tools Isolation & Wiring (T014, T015, A1 regression check).
 */
import { describe, it, expect } from "vitest";
import { createSeepient, askSeepient, gateway } from "../index.js";
import { BUILT_IN_TOOL_MODULES } from "../../../domain/tool-executor.js";
import { createMockRuntime } from "../../../domain/__tests__/test-doubles.js";
import type { GatewaySettingsAdapter } from "../../../capabilities/gateway/settings-adapter.js";

function createMockGatewaySettings(): GatewaySettingsAdapter {
  return {
    getTargets: () => ({}),
    getRoutes: () => [],
    getAdminTargets: () => new Set<string>(),
    saveTarget: () => {},
    deleteTarget: () => {},
    saveRoutes: () => {},
    getCredential: () => undefined,
    setCredential: () => {},
    deleteCredential: () => {},
    listCredentialKeys: () => [],
    addAdminTarget: () => {},
    removeAdminTarget: () => {},
  } as unknown as GatewaySettingsAdapter;
}

describe("SDK Tools Isolation (T014, T015)", () => {
  it("exposes exactly BUILT_IN_TOOL_MODULES definitions when tools option is omitted", async () => {
    const runtime = createMockRuntime([{ content: "ok" }]);
    const agent = await createSeepient({ runtime, tenancy: "single" });

    const defs = agent.getToolDefinitions();
    expect(defs.length).toBe(BUILT_IN_TOOL_MODULES.length);
    expect(defs.map((d) => d.function.name).sort()).toEqual(
      BUILT_IN_TOOL_MODULES.map((m) => m.definition.function.name).sort(),
    );
  });

  it("gateway tools passed to Agent A are absent from Agent B in the same process", async () => {
    const runtime = createMockRuntime([{ content: "ok" }]);
    const adapter = createMockGatewaySettings();

    const gwResult = await gateway.createGateway({ enabled: true } as any, adapter);
    expect(gwResult).not.toBeNull();
    expect(gwResult?.tools.length).toBeGreaterThan(0);

    const agentA = await createSeepient({ runtime, tools: gwResult!.tools, tenancy: "single" });
    const defsA = agentA.getToolDefinitions();
    expect(defsA.some((d) => d.function.name === "gateway_route")).toBe(true);

    const agentB = await createSeepient({ runtime, tenancy: "single" });
    const defsB = agentB.getToolDefinitions();
    expect(defsB.some((d) => d.function.name === "gateway_route")).toBe(false);
  });

  it("sequential gateway.createGateway calls return independent tool arrays (T015)", async () => {
    const adapter1 = createMockGatewaySettings();
    const adapter2 = createMockGatewaySettings();

    const res1 = await gateway.createGateway({ enabled: true } as any, adapter1);
    const res2 = await gateway.createGateway({ enabled: true } as any, adapter2);

    expect(res1).not.toBeNull();
    expect(res2).not.toBeNull();
    expect(res1!.tools).not.toBe(res2!.tools);
    expect(res1!.tools[0]).not.toBe(res2!.tools[0]);
  });

  it("use_skill executes end-to-end through the SDK boundary (A1 regression check)", async () => {
    const { mkdtemp, rm, mkdir, writeFile } = await import("fs/promises");
    const { join } = await import("path");
    const { tmpdir } = await import("os");

    const tempDir = await mkdtemp(join(tmpdir(), "seepient-sdk-skill-"));
    const skillDir = join(tempDir, ".seepient", "skills", "test-skill");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      `---\nname: test-skill\ndescription: A test skill\n---\nTest skill body content\n`,
    );

    try {
      // Model asks to call use_skill, then finishes with the result
      const runtime = createMockRuntime([
        {
          toolCalls: [
            {
              id: "call-skill-1",
              name: "use_skill",
              args: { skill_name: "test-skill" },
            },
          ],
        },
        {
          content: "Skill executed successfully",
        },
      ]);

      const result = await askSeepient("Run the test skill", {
        runtime,
        cwd: tempDir,
        skills: ["test-skill"],
        tenancy: "single",
        onToolResult: (res) => {
          expect(res.callId).toBe("call-skill-1");
        },
      });

      expect(result.text).toBe("Skill executed successfully");
      expect(result.toolCalls.some((c) => c.name === "use_skill")).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
