/**
 * Skill registry ownership and cross-agent isolation test (Spec 021, FR-007).
 *
 * Verifies:
 * 1. Two separate registry instances in one process only access skills from their
 *    own workspace (no module-singleton bleed).
 * 2. use_skill fails closed when no skills registry is supplied in context.
 * 3. UseSkillTool handles skills passed via ToolExecExtra.skills or config.skills.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, realpathSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UseSkillTool } from "../use-skill-tool.js";
import { initializeSkillRegistry } from "../../../capabilities/skills/index.js";

describe("FR-007: Per-agent skill registry ownership & cross-agent isolation", () => {
  let dirA: string;
  let dirB: string;

  beforeEach(() => {
    dirA = realpathSync(mkdtempSync(join(tmpdir(), "seepient-skill-a-")));
    dirB = realpathSync(mkdtempSync(join(tmpdir(), "seepient-skill-b-")));

    // Skill in workspace A
    const skillDirA = join(dirA, ".seepient", "skills", "skill-alpha");
    mkdirSync(skillDirA, { recursive: true });
    writeFileSync(
      join(skillDirA, "SKILL.md"),
      `---
name: skill-alpha
description: Skill Alpha for Workspace A
---
# Skill Alpha
Alpha instructions.
`,
      "utf8",
    );

    // Skill in workspace B
    const skillDirB = join(dirB, ".seepient", "skills", "skill-beta");
    mkdirSync(skillDirB, { recursive: true });
    writeFileSync(
      join(skillDirB, "SKILL.md"),
      `---
name: skill-beta
description: Skill Beta for Workspace B
---
# Skill Beta
Beta instructions.
`,
      "utf8",
    );
  });

  afterEach(() => {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  });

  it("fails closed when use_skill handler is invoked without a skills registry", async () => {
    const result = await UseSkillTool.handler!({ skill_name: "skill-alpha" }, {}, {});
    expect(result).toBe("Error: Skill system not initialized.");
  });

  it("two registries in one process hold only their own workspace skills", async () => {
    const registryA = await initializeSkillRegistry(dirA);
    const registryB = await initializeSkillRegistry(dirB);

    expect(registryA.get("skill-alpha")).toBeDefined();
    expect(registryA.get("skill-beta")).toBeUndefined();

    expect(registryB.get("skill-beta")).toBeDefined();
    expect(registryB.get("skill-alpha")).toBeUndefined();

    // UseSkillTool with registryA works for skill-alpha, fails for skill-beta
    const resultA1 = await UseSkillTool.handler!({ skill_name: "skill-alpha" }, {}, { skills: registryA });
    expect(resultA1).toContain("Alpha instructions");

    const resultA2 = await UseSkillTool.handler!({ skill_name: "skill-beta" }, {}, { skills: registryA });
    expect(resultA2).toContain("Error: Skill 'skill-beta' not found");

    // UseSkillTool with registryB works for skill-beta, fails for skill-alpha
    const resultB1 = await UseSkillTool.handler!({ skill_name: "skill-beta" }, {}, { skills: registryB });
    expect(resultB1).toContain("Beta instructions");

    const resultB2 = await UseSkillTool.handler!({ skill_name: "skill-alpha" }, {}, { skills: registryB });
    expect(resultB2).toContain("Error: Skill 'skill-alpha' not found");
  });

  it("resolves skills from config when passed via config object", async () => {
    const registryA = await initializeSkillRegistry(dirA);
    const result = await UseSkillTool.handler!({ skill_name: "skill-alpha" }, { skills: registryA }, {});
    expect(result).toContain("Alpha instructions");
  });
});
