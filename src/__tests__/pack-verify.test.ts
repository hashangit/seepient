import { describe, it, expect } from "vitest";
import {
  assertNoCleanInPublishHooks,
  assertPackFiles,
  assertNotPlaceholder,
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

  describe("live repo check", () => {
    it("passes against the restored working tree with prepublishOnly safe", () => {
      const result = verifyPack(process.cwd());
      expect(result.success).toBe(true);
      expect(result.count).toBeGreaterThan(0);
    });
  });
});
