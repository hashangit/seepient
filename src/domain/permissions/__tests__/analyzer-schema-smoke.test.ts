import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { DEFAULT_ANALYZERS } from "../../../capabilities/tools/analyzers.js";
import { COMM_ANALYZERS } from "../../../capabilities/tools/comm-analyzers.js";
import { getAllToolModules } from "../../../domain/tool-executor.js";
import { InMemoryArtifactStore } from "../../../capabilities/execution/in-memory-artifact-store.js";
import type { ToolAnalysisContext } from "../../../foundations/contracts/custom-tools.js";
import { computeWorkspaceId } from "../policy-store.js";

function buildMinimalArgs(schema: any): Record<string, any> {
  if (!schema || !schema.properties) return {};
  const props = schema.properties;
  const keys = Object.keys(props);
  const args: Record<string, any> = {};

  for (const key of keys) {
    if (key === "approval") continue;
    const prop = props[key];
    if (!prop) continue;
    if (prop.enum && prop.enum.length > 0) {
      args[key] = prop.enum[0];
    } else if (prop.type === "string") {
      if (key === "url") args[key] = "https://example.com";
      else if (key === "path") args[key] = "sample.txt";
      else if (key === "patch") args[key] = "[sample.txt#0000]\n+added line";
      else if (key === "skill_name") args[key] = "sample-skill";
      else if (key === "command") args[key] = "echo ok";
      else if (key === "prompt") args[key] = "sample prompt";
      else if (key === "query") args[key] = "sample query";
      else if (key === "to") args[key] = "user@example.com";
      else if (key === "subject") args[key] = "sample subject";
      else if (key === "body") args[key] = "sample body";
      else args[key] = `sample_${key}`;
    } else if (prop.type === "number" || prop.type === "integer") {
      args[key] = 1;
    } else if (prop.type === "boolean") {
      args[key] = true;
    } else if (prop.type === "array") {
      if (key === "edits") {
        args[key] = [{ oldText: "old", newText: "new" }];
      } else {
        args[key] = [];
      }
    } else if (prop.type === "object") {
      args[key] = {};
    }
  }
  return args;
}

describe("analyzer schema conformance smoke test", () => {
  let tempDir: string;
  let workspaceRoot: string;
  let artifacts: InMemoryArtifactStore;
  let ctx: ToolAnalysisContext;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "seepient-smoke-"));
    workspaceRoot = path.join(tempDir, "workspace");
    await fs.mkdir(workspaceRoot, { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "sample.txt"), "sample file\n", "utf8");
    artifacts = new InMemoryArtifactStore();
    ctx = {
      principalId: "user-test",
      runId: "run-test",
      toolCallId: "call-test",
      workspace: {
        workspaceId: computeWorkspaceId(workspaceRoot),
        canonicalRoot: workspaceRoot,
        policyVersion: 1,
        policyDigest: "digest-test",
      },
      artifacts,
      modelProviderClass: "*",
    };
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("evaluates all DEFAULT_ANALYZERS with schema-derived minimal args without throwing", async () => {
    const modules = getAllToolModules();
    const modulesByName = new Map(modules.map((m) => [m.definition.function.name, m]));

    for (const [toolName, analyzer] of Object.entries(DEFAULT_ANALYZERS)) {
      const module = modulesByName.get(toolName);
      expect(module, `ToolModule for ${toolName} must exist in tool registry`).toBeDefined();

      const schema = module!.definition.function.parameters;
      const minimalArgs = buildMinimalArgs(schema);

      const action = await analyzer(minimalArgs, ctx);
      expect(action, `Action for ${toolName} must be returned`).toBeDefined();
      expect(action.version).toBe(1);
      expect(action.toolName).toBe(toolName);
      expect(action.operation).toBeDefined();
      expect(Array.isArray(action.effects)).toBe(true);
      expect(action.display).toBeDefined();
      expect(action.actionDigest).toBeDefined();
    }
  });

  it("evaluates all COMM_ANALYZERS with schema-derived minimal args without throwing", async () => {
    const modules = getAllToolModules();
    const modulesByName = new Map(modules.map((m) => [m.definition.function.name, m]));

    for (const [toolName, analyzer] of Object.entries(COMM_ANALYZERS)) {
      const module = modulesByName.get(toolName);
      expect(module, `ToolModule for ${toolName} must exist in tool registry`).toBeDefined();

      const schema = module!.definition.function.parameters;
      const minimalArgs = buildMinimalArgs(schema);

      const action = await analyzer(minimalArgs, ctx);
      expect(action, `Action for ${toolName} must be returned`).toBeDefined();
      expect(action.version).toBe(1);
      expect(action.toolName).toBe(toolName);
      expect(action.operation).toBeDefined();
      expect(Array.isArray(action.effects)).toBe(true);
      expect(action.display).toBeDefined();
      expect(action.actionDigest).toBeDefined();
    }
  });

  it("verifies analyzeUseSkill specifically produces trusted-host operation and normal model-egress", async () => {
    const action = await DEFAULT_ANALYZERS.use_skill({ skill_name: "unslop" }, ctx);
    expect(action.operation).toEqual({
      kind: "trusted-host",
      registrationId: "use_skill",
      toolName: "use_skill",
      args: { skill_name: "unslop" },
    });
    expect(action.effects).toEqual([
      { kind: "host-callback", toolName: "use_skill" },
      {
        kind: "model-egress",
        providerClass: "*",
        dataClasses: ["normal"],
        sources: ["skill-registry"],
      },
    ]);
    expect(action.risk).toBe("safe");
    expect(action.display.canonicalTargets).toEqual([]);
  });
});
