/**
 * Docs-sync gate (021-4 W163c, scope widened per review F7).
 *
 * The VitePress build cannot catch content rot: docs pages kept teaching
 * deleted APIs through three release cycles. This test denies a fixed list
 * of deleted symbols across ALL consumer-facing documentation (every
 * markdown file under docs/ plus the root README) — when a symbol is removed
 * from the code, its doc references must be removed in the same change.
 * CHANGELOG.md is exempt: it is a historical record that legitimately
 * documents the old names in migration notes.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Symbols deleted from the public API — their doc references must go too. */
const DELETED_SYMBOLS = [
  "generateText",
  "streamText",
  "createServer",
  "startServer",
  "GenerateTextOptions",
  "StreamTextOptions",
  "GenerateTextResult",
  "StreamTextResult",
  "ServerOptions",
];

function markdownFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...markdownFilesUnder(full));
    } else if (entry.name.endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

/** Every consumer-facing markdown file: all of docs/ plus the root README. */
function consumerFacingMarkdown(): string[] {
  const files = markdownFilesUnder("docs");
  if (existsSync("README.md")) files.push("README.md");
  return files;
}

describe("W163/F7 docs-sync — no deleted symbols in consumer-facing docs", () => {
  it("all docs markdown and the README reference none of the deleted API surface", () => {
    const offenders: string[] = [];

    for (const file of consumerFacingMarkdown()) {
      const content = readFileSync(file, "utf-8");
      for (const symbol of DELETED_SYMBOLS) {
        const re = new RegExp(`\\b${symbol}\\b`);
        if (re.test(content)) {
          offenders.push(`${file} references deleted symbol "${symbol}"`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
