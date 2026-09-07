import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeSkillRegistry } from "../index.js";
import { FsSkillSources } from "../fs-skill-sources.js";
import { discoverSkills } from "../loader.js";
import { buildSkillCatalog } from "../../../domain/skills/skill-catalog.js";
import type { SkillSource, SkillRecord } from "../../../foundations/contracts/skill-source.js";

let tmpHome: string;

vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  return {
    ...actual,
    homedir: () => tmpHome,
  };
});

beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "seepient-skillsource-home-"));
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

describe("Skill sources composition & FsSkillSources (Spec 021-1, US1)", () => {
  it("FsSkillSources surfaces the five layers in today's order with raw content", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "seepient-fssources-cwd-"));
    try {
      writeSkill(join(cwd, ".seepient", "skills"), "project-skill", "from project");
      const fsSource = new FsSkillSources(cwd);
      const records = await fsSource.list();
      expect(Array.isArray(records)).toBe(true);
      const found = records.find(r => r.name === "project-skill");
      expect(found).toBeDefined();
      expect(found?.content).toContain("name: project-skill");
      expect(found?.content).toContain("Body of project-skill.");
      expect(found?.source).toBeDefined();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("composition [fs, fakeA, fakeB] resolves last-wins on name collision with winning source label attributed", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "seepient-comp-cwd-"));
    try {
      writeSkill(join(cwd, ".seepient", "skills"), "collide", "from fs");
      writeSkill(join(cwd, ".seepient", "skills"), "fs-only", "fs unique");

      const fakeA: SkillSource = {
        list: () => [
          {
            name: "collide",
            content: "---\nname: collide\ndescription: from fakeA\n---\nFakeA body",
            source: "fakeA",
          },
          {
            name: "a-only",
            content: "---\nname: a-only\ndescription: from fakeA\n---\nFakeA only",
            source: "fakeA",
          },
        ],
      };

      const fakeB: SkillSource = {
        list: () => [
          {
            name: "collide",
            content: "---\nname: collide\ndescription: from fakeB\n---\nFakeB body",
            source: "fakeB",
          },
        ],
      };

      const registry = await initializeSkillRegistry(cwd, {
        sources: [fakeA, fakeB],
        tenancyMode: "single",
      });

      const collideSkill = registry.get("collide");
      expect(collideSkill).toBeDefined();
      expect(collideSkill?.description).toBe("from fakeB");
      expect(collideSkill?.source).toBe("fakeB");

      const aOnly = registry.get("a-only");
      expect(aOnly).toBeDefined();
      expect(aOnly?.source).toBe("fakeA");

      const fsOnly = registry.get("fs-only");
      expect(fsOnly).toBeDefined();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("malformed record content from a fake source rejected with the same errors as a malformed file (FR-005)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "seepient-err-cwd-"));
    try {
      const badSource: SkillSource = {
        list: () => [
          {
            name: "bad-skill",
            content: "not a valid frontmatter without name",
            source: "bad-source",
          },
        ],
      };

      await expect(
        initializeSkillRegistry(cwd, { sources: [badSource], tenancyMode: "single" }),
      ).rejects.toThrow(/Skill missing 'name' field/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("no-sources single-mode call produces byte-equivalent registry/catalog golden over bundled + fixture layers (QS-S0)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "seepient-golden-cwd-"));
    try {
      writeSkill(join(cwd, ".seepient", "skills"), "golden-skill", "golden test");

      // Baseline discovery:
      const directSkills = await discoverSkills(cwd);
      const directCatalog = buildSkillCatalog(directSkills.map(s => ({
        name: s.name,
        description: s.description,
        version: s.version,
        tags: s.tags,
        allowedTools: s.allowedTools,
      })));

      // Registry without sources in single-mode:
      const registry = await initializeSkillRegistry(cwd, { tenancyMode: "single" });
      const registryCatalog = buildSkillCatalog(registry.getMetadata());

      expect(registryCatalog).toBe(directCatalog);
      expect(registry.getMetadata()).toEqual(
        directSkills.map(s => ({
          name: s.name,
          description: s.description,
          version: s.version,
          tags: s.tags,
          allowedTools: s.allowedTools,
        }))
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("multi-mode with sources: [] yields an empty registry", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "seepient-empty-cwd-"));
    try {
      writeSkill(join(cwd, ".seepient", "skills"), "should-not-load", "ambient skill");
      const registry = await initializeSkillRegistry(cwd, {
        sources: [],
        tenancyMode: "multi",
      });
      expect(registry.getAll()).toEqual([]);
      expect(registry.getMetadata()).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("multi-mode NEVER invokes ambient discovery (sandbox-home harness per 022 dim-7 pattern)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "seepient-multinoambient-cwd-"));
    try {
      writeSkill(join(tmpHome, ".seepient", "skills"), "home-skill", "global skill");
      writeSkill(join(cwd, ".seepient", "skills"), "project-skill", "local skill");

      const injected: SkillSource = {
        list: () => [
          {
            name: "injected-tenant-skill",
            content: "---\nname: injected-tenant-skill\ndescription: tenant only\n---\nTenant body",
            source: "tenant-source",
          },
        ],
      };

      const registry = await initializeSkillRegistry(cwd, {
        sources: [injected],
        tenancyMode: "multi",
      });

      expect(registry.get("injected-tenant-skill")).toBeDefined();
      expect(registry.get("home-skill")).toBeUndefined();
      expect(registry.get("project-skill")).toBeUndefined();
      expect(registry.getAll().length).toBe(1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
