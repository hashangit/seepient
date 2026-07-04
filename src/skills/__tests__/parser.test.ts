import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { parseSkillFile, parseFrontmatter } from "../parser.js";

async function withTempFile(content: string): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "seepient-test-"));
  const path = join(dir, "test-skill.md");
  await writeFile(path, content, "utf-8");
  return { path, cleanup: () => rm(dir, { recursive: true }) };
}

describe("parseSkillFile", () => {
  it("parses a valid skill file", async () => {
    const { path, cleanup } = await withTempFile(`---
name: test-skill
description: A test skill
version: 2.0.0
author: tester
tags:
  - test
---

This is the skill body.
`);
    try {
      const skill = await parseSkillFile(path);
      expect(skill.name).toBe("test-skill");
      expect(skill.description).toBe("A test skill");
      expect(skill.version).toBe("2.0.0");
      expect(skill.author).toBe("tester");
      expect(skill.tags).toEqual(["test"]);
      expect(skill.filePath).toBe(path);
    } finally {
      await cleanup();
    }
  });

  it("throws if name is missing", async () => {
    const { path, cleanup } = await withTempFile(`---
description: no name
---

body
`);
    try {
      await expect(parseSkillFile(path)).rejects.toThrow("missing 'name'");
    } finally {
      await cleanup();
    }
  });

  it("throws if description is missing", async () => {
    const { path, cleanup } = await withTempFile(`---
name: skill
---

body
`);
    try {
      await expect(parseSkillFile(path)).rejects.toThrow("missing 'description'");
    } finally {
      await cleanup();
    }
  });

  it("defaults version to 1.0.0 and tags to []", async () => {
    const { path, cleanup } = await withTempFile(`---
name: minimal
description: minimal skill
---

body
`);
    try {
      const skill = await parseSkillFile(path);
      expect(skill.version).toBe("1.0.0");
      expect(skill.tags).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});

describe("parseFrontmatter", () => {
  it("parses only frontmatter without body", async () => {
    const { path, cleanup } = await withTempFile(`---
name: fm-only
description: frontmatter only
tags:
  - a
  - b
---

Long body that should not be held in memory.
`);
    try {
      const skill = await parseFrontmatter(path);
      expect(skill.name).toBe("fm-only");
      expect(skill.description).toBe("frontmatter only");
      expect(skill.tags).toEqual(["a", "b"]);
      expect(skill.filePath).toBe(path);
    } finally {
      await cleanup();
    }
  });

  it("throws if name is missing", async () => {
    const { path, cleanup } = await withTempFile(`---
description: no name
---

body
`);
    try {
      await expect(parseFrontmatter(path)).rejects.toThrow("missing 'name'");
    } finally {
      await cleanup();
    }
  });

  it("handles file with no frontmatter delimiters", async () => {
    const { path, cleanup } = await withTempFile("just plain text, no yaml");
    try {
      await expect(parseFrontmatter(path)).rejects.toThrow("missing 'name'");
    } finally {
      await cleanup();
    }
  });
});
