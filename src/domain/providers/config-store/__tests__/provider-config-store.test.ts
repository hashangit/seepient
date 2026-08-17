import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { applyDeepPatch } from "../deep-patch.js";
import { ProviderConfigStore } from "../provider-config-store.js";
import { SeepientError } from "../../../../foundations/errors.js";

describe("ProviderConfigStore & DeepPatch (QS-P4.3)", () => {
  describe("applyDeepPatch", () => {
    it("preserves unmodified fields and merges nested objects", () => {
      const target = {
        work: {
          upstreamProvider: "openai",
          timeoutMs: 30000,
          headers: { "X-Custom": "val1", "X-Keep": "stay" },
        },
      };

      const patch = {
        work: {
          timeoutMs: 60000,
          headers: { "X-Custom": "val2", "X-New": "added" },
        },
      };

      const result = applyDeepPatch(target, patch);
      expect(result.work.upstreamProvider).toBe("openai");
      expect(result.work.timeoutMs).toBe(60000);
      expect(result.work.headers["X-Custom"]).toBe("val2");
      expect(result.work.headers["X-Keep"]).toBe("stay");
      expect(result.work.headers["X-New"]).toBe("added");
    });

    it("deletes fields and entries when patch contains null", () => {
      const target = {
        work: {
          upstreamProvider: "openai",
          timeoutMs: 30000,
          headers: { "X-Custom": "val1", "X-Remove": "bad" },
        },
        personal: {
          upstreamProvider: "anthropic",
        },
      };

      // 1. Unset single header and single property
      const patch1 = {
        work: {
          timeoutMs: null,
          headers: { "X-Remove": null },
        },
      };
      const res1 = applyDeepPatch(target, patch1);
      expect(res1.work.timeoutMs).toBeUndefined();
      expect(res1.work.headers["X-Remove"]).toBeUndefined();
      expect(res1.work.headers["X-Custom"]).toBe("val1");

      // 2. Unset entire provider entry
      const patch2 = {
        personal: null,
      };
      const res2 = applyDeepPatch(res1, patch2);
      expect(res2.personal).toBeUndefined();
      expect(res2.work).toBeDefined();
    });
  });

  describe("ProviderConfigStore", () => {
    let tmpDir: string;
    let overlayFile: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "seepient-cfg-test-"));
      overlayFile = path.join(tmpDir, "overlay.json");
    });

    afterEach(() => {
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("increments revision and persists overlay patches with optimistic concurrency", async () => {
      const store = new ProviderConfigStore(overlayFile);
      const initial = await store.getOverlay();
      expect(initial.revision).toBe(0);

      // Successful update at revision 0
      const updated = await store.updateOverlay(
        {
          providers: {
            "work-openai": {
              adapter: "pi-ai",
              upstreamProvider: "openai",
              credential: { kind: "env", name: "OPENAI_API_KEY" },
            },
          } as any,
        },
        0,
      );

      expect(updated.revision).toBe(1);
      expect((updated.patch.providers as any)?.["work-openai"]).toBeDefined();

      // Fails when expected revision is stale (0 instead of 1)
      await expect(
        store.updateOverlay({ providers: {} }, 0),
      ).rejects.toThrow(SeepientError);

      // Fails when expected revision is omitted
      await expect(
        (store as any).updateOverlay({ providers: {} }),
      ).rejects.toThrow(/expectedRevision is required/);

      // Re-opening store from disk retains persisted state
      const reloadedStore = new ProviderConfigStore(overlayFile);
      const reloaded = await reloadedStore.getOverlay();
      expect(reloaded.revision).toBe(1);
      expect((reloaded.patch.providers as any)?.["work-openai"]).toBeDefined();
    });

    it("throws CORRUPT_STORAGE when overlay file is malformed", () => {
      fs.writeFileSync(overlayFile, "{ corrupt json ...", "utf8");
      expect(() => new ProviderConfigStore(overlayFile)).toThrow(SeepientError);
    });

    it("recovers and acquires lock when prior process crashed or left a stale lock file", async () => {
      const lockPath = `${overlayFile}.lock`;
      // Simulate crashed process lock (dead PID or old timestamp)
      fs.writeFileSync(
        lockPath,
        JSON.stringify({ pid: 99999999, createdAt: Date.now() - 20_000 }),
        "utf8",
      );

      const store = new ProviderConfigStore(overlayFile);
      const res = await store.updateOverlay({ providers: {} }, 0);
      expect(res.revision).toBe(1);
      // Lockfile should be cleaned up after successful acquisition & write
      expect(fs.existsSync(lockPath)).toBe(false);
    });

    it("persists explicit nulls in overlay to suppress base defaults at merge time", async () => {
      const store = new ProviderConfigStore(overlayFile);
      await store.updateOverlay(
        {
          providers: {
            "default-provider": null as any,
          },
        },
        0,
      );

      const overlay = await store.getOverlay();
      expect((overlay.patch.providers as any)?.["default-provider"]).toBeNull();

      const effective = await store.getEffectiveConfig({
        providers: {
          "default-provider": { adapter: "pi-ai", upstreamProvider: "openai", credential: { kind: "none" } },
          "kept-provider": { adapter: "pi-ai", upstreamProvider: "anthropic", credential: { kind: "none" } },
        },
      });

      expect(effective.providers["default-provider"]).toBeUndefined();
      expect(effective.providers["kept-provider"]).toBeDefined();
    });
  });
});
