/**
 * Skills discovery from the cross-agent user directory (~/.agents/skills).
 *
 * Regression guard: user skills installed at ~/.agents/skills (the shared
 * standard used by multiple agents) were invisible to Seepient, so the skill
 * catalog reported "No skills loaded" on machines with no ~/.seepient/skills.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpHome: string;

vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  return {
    ...actual,
    homedir: () => tmpHome,
  };
});

import { discoverSkills } from "../loader.js";

beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "seepient-loader-home-"));
});

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

function writeSkill(root: string, name: string, description: string): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\nBody of ${name}.\n`,
  );
}

describe("skills discovery: ~/.agents/skills", () => {
  it("discovers skills installed only under ~/.agents/skills", async () => {
    writeSkill(join(tmpHome, ".agents", "skills"), "unslop", "remove slop from prose");
    const cwd = mkdtempSync(join(tmpdir(), "seepient-loader-cwd-"));
    try {
      const skills = await discoverSkills(cwd);
      const unslop = skills.find((s) => s.name === "unslop");
      expect(unslop, "skill in ~/.agents/skills must be discovered").toBeDefined();
      expect(unslop?.description).toBe("remove slop from prose");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("~/.seepient/skills wins over ~/.agents/skills on name collision", async () => {
    writeSkill(join(tmpHome, ".agents", "skills"), "collide", "agents copy");
    writeSkill(join(tmpHome, ".seepient", "skills"), "collide", "seepient copy");
    const cwd = mkdtempSync(join(tmpdir(), "seepient-loader-cwd-"));
    try {
      const skills = await discoverSkills(cwd);
      const collide = skills.find((s) => s.name === "collide");
      expect(collide?.description).toBe("seepient copy");
      expect(collide?.source).toContain(join(".seepient", "skills"));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
