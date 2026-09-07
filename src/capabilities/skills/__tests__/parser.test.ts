import { describe, it, expect } from "vitest";
import { parseSkillContent, splitFrontmatter } from "../parser.js";

describe("parseSkillContent", () => {
  it("parses a valid skill content", () => {
    const content = `---
name: test-skill
description: A test skill
version: 2.0.0
author: tester
tags:
  - test
---

This is the skill body.
`;
    const skill = parseSkillContent(content, "custom-source", "/path/to/SKILL.md");
    expect(skill.name).toBe("test-skill");
    expect(skill.description).toBe("A test skill");
    expect(skill.version).toBe("2.0.0");
    expect(skill.author).toBe("tester");
    expect(skill.tags).toEqual(["test"]);
    expect(skill.source).toBe("custom-source");
    expect(skill.filePath).toBe("/path/to/SKILL.md");
  });

  it("throws if name is missing", () => {
    const content = `---
description: no name
---

body
`;
    expect(() => parseSkillContent(content)).toThrow("missing 'name'");
  });

  it("throws if description is missing", () => {
    const content = `---
name: skill
---

body
`;
    expect(() => parseSkillContent(content)).toThrow("missing 'description'");
  });

  it("defaults version to 1.0.0 and tags to []", () => {
    const content = `---
name: minimal
description: minimal skill
---

body
`;
    const skill = parseSkillContent(content);
    expect(skill.version).toBe("1.0.0");
    expect(skill.tags).toEqual([]);
    expect(skill.source).toBe("injected");
    expect(skill.filePath).toBe("");
  });

  it("handles content with no frontmatter delimiters", () => {
    const content = "just plain text, no yaml";
    expect(() => parseSkillContent(content)).toThrow("missing 'name'");
  });
});

describe("splitFrontmatter", () => {
  it("handles content with no frontmatter", () => {
    const raw = "just plain text\nline 2";
    const { yaml, body } = splitFrontmatter(raw);
    expect(yaml).toBe("");
    expect(body).toBe("just plain text\nline 2");
  });

  it("handles unclosed frontmatter", () => {
    const raw = "---\nname: foo\ndescription: bar\nbody without closing delimiter";
    const { yaml, body } = splitFrontmatter(raw);
    expect(yaml).toBe("");
    expect(body).toBe(raw);
  });

  it("splits normal frontmatter and body", () => {
    const raw = `---
name: foo
description: bar
---

Here is the body.
More lines.
`;
    const { yaml, body } = splitFrontmatter(raw);
    expect(yaml).toBe("name: foo\ndescription: bar");
    expect(body).toBe("Here is the body.\nMore lines.\n");
  });
});
