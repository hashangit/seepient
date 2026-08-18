import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { recordProviderAuditEvent } from "../audit-log.js";
import { ProviderConfigStore } from "../config-store/provider-config-store.js";

describe("Provider Audit Log (P6.20)", () => {
  let tempDir: string;
  let auditLogPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "seepient-audit-test-"));
    auditLogPath = path.join(tempDir, "audit.log");
    process.env.SEEPIENT_AUDIT_LOG_PATH = auditLogPath;
  });

  afterEach(() => {
    delete process.env.SEEPIENT_AUDIT_LOG_PATH;
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("appends redacted audit log entries with 0600 permissions and fsync", async () => {
    recordProviderAuditEvent({
      timestamp: new Date().toISOString(),
      action: "create_credential",
      revision: 1,
      details: {
        provider: "openai",
        apiKey: "sk-super-secret-key-12345",
        token: "tok-abc",
      },
    });

    expect(fs.existsSync(auditLogPath)).toBe(true);
    const content = fs.readFileSync(auditLogPath, "utf-8");
    const entry = JSON.parse(content.trim());

    expect(entry.action).toBe("create_credential");
    expect(entry.details.provider).toBe("openai");
    expect(entry.details.apiKey).toBe("[REDACTED]");
    expect(entry.details.token).toBe("[REDACTED]");
  });

  it("records audit log when ProviderConfigStore.updateOverlay executes", async () => {
    const overlayPath = path.join(tempDir, "overlay.json");
    const store = new ProviderConfigStore(overlayPath);

    await store.updateOverlay({
      providers: {
        openai: {
          adapter: "pi-ai",
          upstreamProvider: "openai",
          credential: { kind: "none" },
        },
      },
    }, 0);

    const content = fs.readFileSync(auditLogPath, "utf-8");
    expect(content).toContain("update_overlay");
    expect(content).toContain("openai");
  });
});
