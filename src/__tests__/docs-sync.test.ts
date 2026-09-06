/**
 * Docs-sync gate (021-4 W163c).
 *
 * The VitePress build cannot catch content rot: docs pages kept teaching
 * deleted APIs through three release cycles. This test denies a fixed list
 * of deleted symbols in the consumer-facing SDK and server docs — when a
 * symbol is removed from the code, its doc references must be removed in
 * the same change.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
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

describe("W163 docs-sync — no deleted symbols in consumer-facing docs", () => {
  it("docs/sdk and docs/server reference none of the deleted API surface", () => {
    const offenders: string[] = [];

    for (const file of [...markdownFilesUnder("docs/sdk"), ...markdownFilesUnder("docs/server")]) {
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
