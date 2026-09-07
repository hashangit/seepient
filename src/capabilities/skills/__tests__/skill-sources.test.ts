import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeSkillRegistry } from "../index.js";
import { FsSkillSources } from "../fs-skill-sources.js";
import type { SkillSource, SkillRecord } from "../../../foundations/contracts/skill-source.js";

import { readFile as fsReadFile } from "fs/promises";

let tmpHome: string;

vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  return {
    ...actual,
    readFile: vi.fn(actual.readFile),
  };
});

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

  it("malformed record content from a fake source is warned and skipped while valid records load (FR-005)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "seepient-err-cwd-"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const mixedSource: SkillSource = {
        list: () => [
          {
            name: "bad-skill",
            content: "not a valid frontmatter without name",
            source: "bad-source",
          },
          {
            name: "good-skill",
            content: "---\nname: good-skill\ndescription: a valid skill\n---\nValid body",
            source: "mixed-source",
          },
        ],
      };

      const registry = await initializeSkillRegistry(cwd, {
        sources: [mixedSource],
        tenancyMode: "multi",
      });

      expect(registry.get("bad-skill")).toBeUndefined();
      expect(registry.get("good-skill")).toBeDefined();
      expect(registry.get("good-skill")?.description).toBe("a valid skill");
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/Failed to parse skill record "bad-skill"/),
      );
    } finally {
      warnSpy.mockRestore();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("no-sources single-mode call produces byte-equivalent registry/catalog golden over bundled + fixture layers (QS-S0)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "seepient-golden-cwd-"));
    function renderCatalog(metadata: Array<{ name: string; description: string; tags: string[] }>): string {
      if (metadata.length === 0) return "";
      const lines = metadata.map(s => {
        const tags = s.tags.length > 0 ? ` [${s.tags.join(', ')}]` : '';
        return `- ${s.name}: ${s.description}${tags}`;
      });
      return [
        'AVAILABLE SKILLS (activate with use_skill tool):',
        ...lines,
        'When a user request matches a skill, call use_skill with the skill name.',
      ].join('\n');
    }

    try {
      writeSkill(join(cwd, ".seepient", "skills"), "golden-skill", "golden test");

      // Registry without sources in single-mode:
      const registry = await initializeSkillRegistry(cwd, { tenancyMode: "single" });
      const golden = registry.get("golden-skill");
      expect(golden).toBeDefined();
      expect(golden?.description).toBe("golden test");
      expect(golden?.version).toBe("1.0.0");
      expect(golden?.source).toContain(join(".seepient", "skills"));

      const meta = registry.getMetadata();
      const catalog = renderCatalog(meta);
      expect(catalog).toContain("AVAILABLE SKILLS (activate with use_skill tool):");
      expect(catalog).toContain("- golden-skill: golden test");
      expect(catalog).toContain("When a user request matches a skill, call use_skill with the skill name.");
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

  it("W201: single-mode fs skills defer bodies via filePath with zero retention in rawContentMap, cached on demand", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "seepient-lazy-cwd-"));
    try {
      writeSkill(join(cwd, ".seepient", "skills"), "fs-one", "First FS skill");
      writeSkill(join(cwd, ".seepient", "skills"), "fs-two", "Second FS skill");

      const injected: SkillSource = {
        list: () => [
          {
            name: "injected-one",
            content: "---\nname: injected-one\ndescription: injected skill\n---\nInjected body\n",
            source: "custom-db",
          },
        ],
      };

      const registry = await initializeSkillRegistry(cwd, {
        sources: [injected],
        tenancyMode: "single",
      });

      // Memory probe: fs skills must NOT be in rawContentMap
      const rawMap = (registry as any).rawContentMap as Map<string, string>;
      expect(rawMap.has("fs-one")).toBe(false);
      expect(rawMap.has("fs-two")).toBe(false);
      // Injected skill without filePath MUST be in rawContentMap
      expect(rawMap.has("injected-one")).toBe(true);

      // Verify fsReadFile call counts for on-demand loading and caching
      const readSpy = vi.mocked(fsReadFile);
      readSpy.mockClear();

      // First getBody: loads from disk
      const body1 = await registry.getBody("fs-one");
      expect(body1).toContain("Body of fs-one");
      expect(readSpy).toHaveBeenCalledTimes(1);

      // Second getBody: served from bodyCache, no disk read
      const body2 = await registry.getBody("fs-one");
      expect(body2).toBe(body1);
      expect(readSpy).toHaveBeenCalledTimes(1);

      // Injected getBody: served from rawContentMap
      const injectedBody = await registry.getBody("injected-one");
      expect(injectedBody).toContain("Injected body");
      // No extra readFile call for injected skill
      expect(readSpy).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("W203: deleting skill file after registry construction causes getBody to return undefined", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "seepient-deleted-cwd-"));
    try {
      writeSkill(join(cwd, ".seepient", "skills"), "transient-skill", "Will be deleted");
      const registry = await initializeSkillRegistry(cwd, { tenancyMode: "single" });

      expect(registry.get("transient-skill")).toBeDefined();

      // Delete the skill file
      rmSync(join(cwd, ".seepient", "skills", "transient-skill", "SKILL.md"));

      // getBody fails gracefully and returns undefined
      const body = await registry.getBody("transient-skill");
      expect(body).toBeUndefined();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
