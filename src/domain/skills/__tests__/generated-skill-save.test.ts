import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, realpathSync, readdirSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SkillRecord, SkillSource, SkillStore } from "../../../foundations/contracts/skill-source.js";
import { saveGeneratedSkill, SkillStoreUnavailableError } from "../generated-skill-save.js";

function snapshotDir(root: string): Map<string, { size: number; mtimeMs: number }> {
  const map = new Map<string, { size: number; mtimeMs: number }>();
  if (!existsSync(root)) return map;

  function walk(current: string, relative: string) {
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(current, entry.name);
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      const stat = statSync(full);
      map.set(rel, { size: stat.size, mtimeMs: stat.mtimeMs });
      if (entry.isDirectory()) {
        walk(full, rel);
      }
    }
  }

  walk(root, "");
  return map;
}

function diffSnapshots(
  before: Map<string, { size: number; mtimeMs: number }>,
  after: Map<string, { size: number; mtimeMs: number }>,
): string[] {
  const diffs: string[] = [];
  for (const [path, info] of after.entries()) {
    const prev = before.get(path);
    if (!prev) {
      diffs.push(`CREATED: ${path}`);
    } else if (prev.size !== info.size || prev.mtimeMs !== info.mtimeMs) {
      diffs.push(`MODIFIED: ${path}`);
    }
  }
  return diffs;
}

class FakeMemorySkillStore implements SkillStore {
  public records: SkillRecord[] = [];

  constructor(initial: SkillRecord[] = []) {
    this.records = [...initial];
  }

  async list(): Promise<SkillRecord[]> {
    return [...this.records];
  }

  async save(record: SkillRecord): Promise<void> {
    const idx = this.records.findIndex((r) => r.name === record.name);
    if (idx >= 0) {
      this.records[idx] = record;
    } else {
      this.records.push(record);
    }
  }
}

describe("Generated Skill Save Path (Spec 021-1, US2, QS-S2)", () => {
  it("saves generated skill through a fake SkillStore with kind: generated", async () => {
    const store = new FakeMemorySkillStore();

    const result = await saveGeneratedSkill({
      name: "calc-helper",
      description: "Helper for math operations",
      body: "# Calculator Helper\nPerform arithmetic.",
      sources: [store],
    });

    expect(result.saved).toBe(true);
    expect(result.version).toBe(1);

    const records = await store.list();
    expect(records.length).toBe(1);
    expect(records[0].name).toBe("calc-helper");
    expect(records[0].content).toContain("kind: generated");
    expect(records[0].content).toContain("version: 1");
    expect(records[0].content).toContain("# Calculator Helper");
  });

  it("same-name save refuses with collision guidance, version + changelog bump on explicit replacement", async () => {
    const store = new FakeMemorySkillStore();

    await saveGeneratedSkill({
      name: "data-cleaner",
      description: "Clean messy data",
      body: "# Cleaner v1",
      sources: [store],
    });

    // Attempt save without replace flag -> must refuse with collision guidance
    await expect(
      saveGeneratedSkill({
        name: "data-cleaner",
        description: "Attempted duplicate",
        body: "# Cleaner v2",
        sources: [store],
      }),
    ).rejects.toThrow(/collision|already exists/i);

    // Explicit replacement -> increments version and updates changelog
    const replaced = await saveGeneratedSkill({
      name: "data-cleaner",
      description: "Clean messy data v2",
      body: "# Cleaner v2 body",
      sources: [store],
      replace: true,
      changelogEntry: "Upgraded regex patterns",
    });

    expect(replaced.saved).toBe(true);
    expect(replaced.version).toBe(2);

    const records = await store.list();
    expect(records.length).toBe(1);
    expect(records[0].content).toContain("version: 2");
    expect(records[0].content).toContain("Upgraded regex patterns");
    expect(records[0].content).toContain("# Cleaner v2 body");
  });

  it("two tenant-scoped stores stay disjoint (a save to one is invisible to the other's list())", async () => {
    const tenantAStore = new FakeMemorySkillStore();
    const tenantBStore = new FakeMemorySkillStore();

    await saveGeneratedSkill({
      name: "tenant-a-procedure",
      description: "Procedure for Tenant A",
      body: "# Tenant A Only",
      sources: [tenantAStore],
    });

    const recordsA = await tenantAStore.list();
    const recordsB = await tenantBStore.list();

    expect(recordsA.find((r) => r.name === "tenant-a-procedure")).toBeDefined();
    expect(recordsB.find((r) => r.name === "tenant-a-procedure")).toBeUndefined();
    expect(recordsB.length).toBe(0);
  });

  it("with TWO stores in the effective list the LAST one is the save destination", async () => {
    const globalStore = new FakeMemorySkillStore();
    const tenantStore = new FakeMemorySkillStore();

    await saveGeneratedSkill({
      name: "custom-export",
      description: "Export custom format",
      body: "# Export Script",
      sources: [globalStore, tenantStore],
    });

    const globalRecords = await globalStore.list();
    const tenantRecords = await tenantStore.list();

    expect(globalRecords.length).toBe(0);
    expect(tenantRecords.length).toBe(1);
    expect(tenantRecords[0].name).toBe("custom-export");
  });

  it("with no store the save path throws SKILL_STORE_UNAVAILABLE and pinned-root harness proves zero disk writes", async () => {
    const tempHome = realpathSync(mkdtempSync(join(tmpdir(), "seepient-qs-s2-home-")));
    const tempSec = realpathSync(mkdtempSync(join(tmpdir(), "seepient-qs-s2-sec-")));
    const tempCwd = realpathSync(mkdtempSync(join(tmpdir(), "seepient-qs-s2-cwd-")));

    try {
      const snapBeforeHome = snapshotDir(tempHome);
      const snapBeforeSec = snapshotDir(tempSec);
      const snapBeforeCwd = snapshotDir(tempCwd);

      const readOnlySource: SkillSource = {
        list: () => [],
      };

      let thrownError: any;
      try {
        await saveGeneratedSkill({
          name: "orphan-skill",
          description: "Cannot save without store",
          body: "# Orphan",
          sources: [readOnlySource],
        });
      } catch (err: any) {
        thrownError = err;
      }

      expect(thrownError).toBeDefined();
      expect(thrownError.code).toBe("SKILL_STORE_UNAVAILABLE");
      expect(thrownError.message).toMatch(/SKILL_STORE_UNAVAILABLE|No SkillStore/i);
      expect(thrownError.message).toMatch(/remediation|sources|inject/i);

      // Verify zero disk writes across all pinned roots
      const diffHome = diffSnapshots(snapBeforeHome, snapshotDir(tempHome));
      const diffSec = diffSnapshots(snapBeforeSec, snapshotDir(tempSec));
      const diffCwd = diffSnapshots(snapBeforeCwd, snapshotDir(tempCwd));

      expect(diffHome).toEqual([]);
      expect(diffSec).toEqual([]);
      expect(diffCwd).toEqual([]);
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
      rmSync(tempSec, { recursive: true, force: true });
      rmSync(tempCwd, { recursive: true, force: true });
    }
  });

  it("preserves tags and allowedTools across replacements and formats YAML safely", async () => {
    const store = new FakeMemorySkillStore();

    // Initial save with tags, allowedTools, and a description containing colons and quotes
    await saveGeneratedSkill({
      name: "commit-helper",
      description: "Helper for git: handles 'quotes' and colons",
      body: "# Commit Helper Body",
      tags: ["git", "vcs"],
      allowedTools: ["exec_command"],
      sources: [store],
    });

    const [firstRecord] = await store.list();
    expect(firstRecord.content).toContain("tags:\n  - git\n  - vcs");
    expect(firstRecord.content).toContain("allowedTools:\n  - exec_command");
    expect(firstRecord.content).toContain('description: "Helper for git: handles \'quotes\' and colons"');

    // Replace without re-specifying tags and allowedTools -> must preserve them
    await saveGeneratedSkill({
      name: "commit-helper",
      description: "Updated description: still with colon",
      body: "# Updated Body",
      replace: true,
      changelogEntry: "Update without tags param",
      sources: [store],
    });

    const [updatedRecord] = await store.list();
    expect(updatedRecord.content).toContain("version: 2");
    expect(updatedRecord.content).toContain("tags:\n  - git\n  - vcs");
    expect(updatedRecord.content).toContain("allowedTools:\n  - exec_command");
    expect(updatedRecord.content).toContain('description: "Updated description: still with colon"');
    expect(updatedRecord.content).toContain("Update without tags param");
  });
});
