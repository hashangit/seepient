import { describe, it, expect } from "vitest";
import { readFileSync, mkdirSync, rmSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertNoCleanInPublishHooks,
  assertPackFiles,
  assertNotPlaceholder,
  assertReleaseWorkflowInvariants,
  verifyPack,
  REQUIRED_PACK_FILES,
} from "../../scripts/pack-verify.mjs";

describe("Pack Verification Gate (Spec 021-2 / FR-001)", () => {
  describe("assertNoCleanInPublishHooks (Negative Control 1: Static Hook Assertion)", () => {
    it("throws when prepublishOnly contains 'clean'", () => {
      expect(() => {
        assertNoCleanInPublishHooks({
          scripts: {
            prepublishOnly: "pnpm run clean && pnpm run build",
          },
        });
      }).toThrow(/Static hook assertion failed.*prepublishOnly/);
    });

    it("throws when prepublishOnly contains 'rm -rf dist'", () => {
      expect(() => {
        assertNoCleanInPublishHooks({
          scripts: {
            prepublishOnly: "rm -rf dist && tsc",
          },
        });
      }).toThrow(/Static hook assertion failed.*prepublishOnly/);
    });

    it("throws when prepack contains 'clean'", () => {
      expect(() => {
        assertNoCleanInPublishHooks({
          scripts: {
            prepack: "npm run clean",
          },
        });
      }).toThrow(/Static hook assertion failed.*prepack/);
    });

    it("throws when prepare contains 'clean'", () => {
      expect(() => {
        assertNoCleanInPublishHooks({
          scripts: {
            prepare: "npm run clean",
          },
        });
      }).toThrow(/Static hook assertion failed.*prepare/);
    });

    it("throws when prepare contains 'rm -rf dist'", () => {
      expect(() => {
        assertNoCleanInPublishHooks({
          scripts: {
            prepare: "rm -rf dist",
          },
        });
      }).toThrow(/Static hook assertion failed.*prepare/);
    });

    it("passes when prepublishOnly is safe (e.g. 'pnpm run build')", () => {
      expect(() => {
        assertNoCleanInPublishHooks({
          scripts: {
            clean: "rm -rf dist",
            build: "tsc",
            prepublishOnly: "pnpm run build",
          },
        });
      }).not.toThrow();
    });
  });

  describe("assertNotPlaceholder (W018: Placeholder Honesty)", () => {
    it("throws when manifest has placeholder: true", () => {
      expect(() => {
        assertNotPlaceholder({ placeholder: true });
      }).toThrow(/Refusing to publish package containing placeholder native binaries/);
    });

    it("passes when manifest does not carry placeholder marker", () => {
      expect(() => {
        assertNotPlaceholder({ placeholder: false });
      }).not.toThrow();
      expect(() => {
        assertNotPlaceholder({});
      }).not.toThrow();
    });
  });

  describe("assertPackFiles (Negative Control 2: Missing File Assertion)", () => {
    it("throws when manifest.json is missing from pack list", () => {
      const filesWithoutManifest = REQUIRED_PACK_FILES.filter(
        (f: string) => !f.endsWith("manifest.json"),
      );
      expect(() => {
        assertPackFiles(filesWithoutManifest);
      }).toThrow(/missing required files in tarball:[\s\S]*manifest\.json/);
    });

    it("throws when any platform binary is missing", () => {
      const filesWithoutDarwin = REQUIRED_PACK_FILES.filter(
        (f: string) => !f.includes("darwin-arm64"),
      );
      expect(() => {
        assertPackFiles(filesWithoutDarwin);
      }).toThrow(/missing required files in tarball:[\s\S]*darwin-arm64\/seepient-fs-commit/);
    });

    it("passes when all required files are present", () => {
      expect(() => {
        assertPackFiles(REQUIRED_PACK_FILES);
      }).not.toThrow();
    });
  });

  describe("release.yml invariant self-test (T019, review P2-5)", () => {
    // Splice markers are FULL LINES: the parsed-step invariants read real
    // YAML, and a mid-line slice would glue a dangling `- name:` prefix onto
    // the next job key (a malformed fixture, not an evasion).
    const CORE_STEP_LINE = "      - name: Publish seepient-core FIRST";
    const ROOT_STEP_LINE = "      - name: Publish seepient (root)";

    function spliceRootBeforeCore(original: string, transformCoreBlock?: (block: string) => string): string {
      const coreIdx = original.indexOf(CORE_STEP_LINE);
      const rootIdx = original.indexOf(ROOT_STEP_LINE);
      const homebrewIdx = original.indexOf("\n  publish-homebrew:", rootIdx);
      const coreBlock = transformCoreBlock
        ? transformCoreBlock(original.slice(coreIdx, rootIdx))
        : original.slice(coreIdx, rootIdx);
      const rootBlock = original.slice(rootIdx, homebrewIdx + 1);
      return original.slice(0, coreIdx) + rootBlock + coreBlock + original.slice(homebrewIdx + 1);
    }

    it("an order-swapped workflow copy (root published before core) fails the invariants", () => {
      const tmp = mkdtempSync(join(tmpdir(), "release-invariants-"));
      try {
        const original = readFileSync(join(process.cwd(), ".github/workflows/release.yml"), "utf8");
        expect(original.indexOf(CORE_STEP_LINE)).toBeGreaterThan(-1);
        expect(original.indexOf(ROOT_STEP_LINE)).toBeGreaterThan(original.indexOf(CORE_STEP_LINE));
        const swapped = spliceRootBeforeCore(original);
        mkdirSync(join(tmp, ".github/workflows"), { recursive: true });
        writeFileSync(join(tmp, ".github/workflows/release.yml"), swapped);
        expect(() => assertReleaseWorkflowInvariants(tmp)).toThrow(/core/i);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    // Round-3 OQ-4: the line-grep invariants were evadable. Fixture 1 — the
    // build:core requirement satisfied ONLY by a comment inside the step's
    // run block (the exact P0-1 class). The old raw-text grep matched the
    // comment and stayed green.
    it("a comment-satisfiable build:core step fails the invariants", () => {
      const tmp = mkdtempSync(join(tmpdir(), "release-invariants-"));
      try {
        const original = readFileSync(join(process.cwd(), ".github/workflows/release.yml"), "utf8");
        const commented = original.replace(
          "run: pnpm run build:core && pnpm build",
          ["run: |", "    # pnpm run build:core", "    echo 'skipping build'"].join("\n"),
        );
        expect(commented).not.toBe(original);
        mkdirSync(join(tmp, ".github/workflows"), { recursive: true });
        writeFileSync(join(tmp, ".github/workflows/release.yml"), commented);
        expect(() => assertReleaseWorkflowInvariants(tmp)).toThrow(/build:core/i);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    // Round-3 OQ-4: Fixture 2 — the core publish command split across lines
    // so no single line carries both markers (the marker co-location class),
    // AND placed AFTER the root publish. The old single-line findIndex saw
    // no line with both markers, left coreLine at -1, and stayed green with
    // the order inverted.
    it("a line-split core publish ordered after the root publish fails the invariants", () => {
      const tmp = mkdtempSync(join(tmpdir(), "release-invariants-"));
      try {
        const original = readFileSync(join(process.cwd(), ".github/workflows/release.yml"), "utf8");
        const swapped = spliceRootBeforeCore(original, (coreBlock) =>
          coreBlock.replace(
            "cd packages/core && pnpm publish --access public --no-git-checks --provenance",
            ["cd packages/core", "pnpm publish --access public --no-git-checks --provenance"].join("\n"),
          ),
        );
        mkdirSync(join(tmp, ".github/workflows"), { recursive: true });
        writeFileSync(join(tmp, ".github/workflows/release.yml"), swapped);
        expect(() => assertReleaseWorkflowInvariants(tmp)).toThrow(/core/i);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  describe("live repo check", () => {
    it("passes against the restored working tree with prepublishOnly safe", () => {
      const result = verifyPack(process.cwd(), { allowPlaceholder: true });
      expect(result.success).toBe(true);
      expect(result.files).toBeGreaterThan(0);
    });
  });
});
