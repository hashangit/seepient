import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { ProviderConfigStore } from "../config-store/provider-config-store.js";

describe("Lock TOCTOU Restoration & Concurrency", () => {
  let tmpDir: string;
  let overlayPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "seepient-lock-test-"));
    overlayPath = path.join(tmpDir, "overlay.json");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("safely cleans dead/stale lock via atomic rename without race condition", async () => {
    const lockPath = `${overlayPath}.lock`;
    // Write a stale lock file with a dead PID (e.g. 9999999)
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: 9999999, createdAt: Date.now() - 400_000 }),
    );

    const store = new ProviderConfigStore(overlayPath);
    const result = await store.updateOverlay(
      {
        retryPolicy: { maxAttempts: 2 },
      },
      0,
    );

    expect(result.revision).toBe(1);
    expect(fs.existsSync(overlayPath)).toBe(true);
  });

  it("returns cloned snapshot from getOverlay preventing external reference mutation", async () => {
    const store = new ProviderConfigStore(overlayPath);
    const overlay1 = await store.getOverlay();
    overlay1.revision = 999;
    (overlay1 as any).patch = { polluted: true };

    const overlay2 = await store.getOverlay();
    expect(overlay2.revision).toBe(0);
    expect(overlay2.patch).toEqual({});
  });
});
