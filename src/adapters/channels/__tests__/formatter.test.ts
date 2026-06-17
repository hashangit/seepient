import { describe, it, expect } from "vitest";
import { formatForPlatform, chunkText, stripMarkdown } from "../formatter.js";

describe("formatForPlatform", () => {
  it("returns one chunk when text fits the platform limit", () => {
    const chunks = formatForPlatform("telegram", "short text");
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe("short text");
  });

  it("chunks long text to the Telegram 4096 limit", () => {
    const long = "a".repeat(9000);
    const chunks = formatForPlatform("telegram", long);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect((c.text ?? "").length).toBeLessThanOrEqual(4096);
    }
    // Reassembled text preserves all content.
    expect(chunks.map((c) => c.text).join("")).toBe(long);
  });

  it("strips Markdown for WhatsApp (no native Markdown)", () => {
    const chunks = formatForPlatform("whatsapp", "**bold** and _italic_");
    expect(chunks[0].text).toBe("bold and italic");
  });

  it("preserves Markdown for platforms that render it", () => {
    const chunks = formatForPlatform("telegram", "**bold**");
    expect(chunks[0].text).toBe("**bold**");
  });
});

describe("chunkText", () => {
  it("breaks on newlines when possible", () => {
    const text = "first line\nsecond line";
    const chunks = chunkText(text, 12);
    expect(chunks.length).toBe(2);
  });

  it("returns the whole string when under the limit", () => {
    expect(chunkText("tiny", 100)).toEqual(["tiny"]);
  });
});

describe("stripMarkdown", () => {
  it("unwraps bold, italic, code, links, headers", () => {
    expect(stripMarkdown("**b**")).toBe("b");
    expect(stripMarkdown("*i*")).toBe("i");
    expect(stripMarkdown("`c`")).toBe("c");
    expect(stripMarkdown("[t](https://x)")).toBe("t");
    expect(stripMarkdown("## Heading")).toBe("Heading");
    expect(stripMarkdown("~~strikethrough~~")).toBe("strikethrough");
  });

  it("keeps fenced code block contents", () => {
    expect(stripMarkdown("```js\nconst x = 1;\n```")).toBe("const x = 1;\n");
  });
});
