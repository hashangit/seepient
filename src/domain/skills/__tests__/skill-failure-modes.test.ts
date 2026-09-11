import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { invokeSkill } from "../skill-invoker.js";
import { UseSkillTool } from "../use-skill-tool.js";
import { DefaultSkillRegistry } from "../../../capabilities/skills/registry.js";
import { initializeSkillRegistry } from "../../../capabilities/skills/index.js";
import {
  computeEffectiveSkillSources,
  emitMultiZeroSourcesNoticeOnce,
  resetMultiZeroSourcesNoticeForTest,
} from "../../../capabilities/skills/skill-sources-helper.js";
import { SkillBodyUnavailableError } from "../../../foundations/errors.js";
import type { Skill, SkillRegistry } from "../../../capabilities/skills/types.js";
import type { SkillSource } from "../../../foundations/contracts/skill-source.js";

describe("Skill Failure Modes & Warnings (Spec 022-1, US5 / FR-034, FR-038)", () => {
  let consoleWarnSpy: any;
  let warnLogs: string[] = [];

  beforeEach(() => {
    warnLogs = [];
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation((...args) => {
      warnLogs.push(args.join(" "));
    });
    resetMultiZeroSourcesNoticeForTest();
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
    delete process.env.SEEPIENT_SKILL_BODY_WARN_CHARS;
  });

  it("invokeSkill throws SkillBodyUnavailableError when skill body is empty/missing", async () => {
    const mockSkill: Skill = {
      name: "broken-skill",
      description: "A skill with missing body",
      version: "1.0.0",
      priority: 0,
      basePath: "",
      frontmatter: { name: "broken-skill", description: "A skill with missing body" },
      tags: [],
      source: "test",
      filePath: "",
    };

    const mockRegistry: SkillRegistry = {
      get: vi.fn((name) => (name === "broken-skill" ? mockSkill : undefined)),
      getMetadata: vi.fn(() => [mockSkill]),
      getAll: vi.fn(() => [mockSkill]),
      getBody: vi.fn(async () => ""),
    };

    await expect(invokeSkill({ input: "/broken-skill", registry: mockRegistry })).rejects.toThrow(
      SkillBodyUnavailableError,
    );

    try {
      await invokeSkill({ input: "/broken-skill", registry: mockRegistry });
    } catch (err: any) {
      expect(err.code).toBe("SKILL_BODY_UNAVAILABLE");
      expect(err.message).toContain("broken-skill");
      expect(err.message).toContain("unavailable or unreadable");
    }
  });

  it("UseSkillTool returns typed SKILL_BODY_UNAVAILABLE error string when body is unreadable", async () => {
    const mockSkill: Skill = {
      name: "unreadable-skill",
      description: "A skill with unreadable body",
      version: "1.0.0",
      priority: 0,
      basePath: "",
      frontmatter: { name: "unreadable-skill", description: "A skill with unreadable body" },
      tags: [],
      source: "test",
      filePath: "",
    };

    const mockRegistry: SkillRegistry = {
      get: vi.fn((name) => (name === "unreadable-skill" ? mockSkill : undefined)),
      getMetadata: vi.fn(() => [mockSkill]),
      getAll: vi.fn(() => [mockSkill]),
      getBody: vi.fn(async () => ""),
    };

    const result = await UseSkillTool.handler!({ skill_name: "unreadable-skill" }, {}, { skills: mockRegistry });
    expect(typeof result).toBe("string");
    expect(result).toContain("Error: SKILL_BODY_UNAVAILABLE");
    expect(result).toContain("unreadable-skill");
    expect(result).toContain("unavailable or unreadable");
  });

  it("source-init failure warns with source label and continues", async () => {
    const failingSource: SkillSource = {
      list: vi.fn(async () => {
        throw new Error("Network timeout loading remote skills");
      }),
    };
    (failingSource as any).name = "remote-http-source";

    const workingSource: SkillSource = {
      list: vi.fn(async () => [
        {
          name: "working-skill",
          content: "---\nname: working-skill\ndescription: working\n---\nBody here\n",
          source: "working-source",
        },
      ]),
    };

    const registry = await initializeSkillRegistry("/tmp", {
      sources: [failingSource, workingSource],
      tenancyMode: "multi",
    });

    expect(registry.get("working-skill")).toBeDefined();
    const joinedWarn = warnLogs.join("\n");
    expect(joinedWarn).toContain("remote-http-source");
    expect(joinedWarn).toContain("failed to load skills");
    expect(joinedWarn).toContain("Continuing with remaining sources");
  });

  it("multi-tenant mode with zero sources logs one-time informational notice", () => {
    emitMultiZeroSourcesNoticeOnce();
    emitMultiZeroSourcesNoticeOnce();

    expect(warnLogs.length).toBe(1);
    expect(warnLogs[0]).toContain("Multi-tenant mode running with zero skill sources");
  });

  it("body warning logs once per skill when body exceeds warn chars (FR-038)", async () => {
    process.env.SEEPIENT_SKILL_BODY_WARN_CHARS = "50";

    const mockSkill: Skill = {
      name: "large-skill",
      description: "Large skill",
      version: "1.0.0",
      priority: 0,
      basePath: "",
      frontmatter: { name: "large-skill", description: "Large skill" },
      tags: [],
      source: "test",
      filePath: "",
    };

    const largeBody = "X".repeat(100);
    const rawMap = new Map([["large-skill", `---\nname: large-skill\n---\n${largeBody}`]]);
    const registry = new DefaultSkillRegistry([mockSkill], rawMap);

    // First retrieval should log warning
    const body1 = await registry.getBody("large-skill");
    expect(body1).toBe(largeBody);
    expect(warnLogs.some((l) => l.includes("large-skill") && l.includes("50 chars"))).toBe(true);

    // Second retrieval of the same skill should NOT log another warning
    const countBefore = warnLogs.length;
    const body2 = await registry.getBody("large-skill");
    expect(body2).toBe(largeBody);
    expect(warnLogs.length).toBe(countBefore);
  });

  it("malformed inline literals warn with name (FR-038)", () => {
    computeEffectiveSkillSources([], [
      {
        name: "broken-literal",
      } as any,
    ]);

    const joinedWarn = warnLogs.join("\n");
    expect(joinedWarn).toContain('Malformed inline skill literal "broken-literal"');
  });
});
