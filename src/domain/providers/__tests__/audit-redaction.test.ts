import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { recordProviderAuditEvent, scrubAuditLog } from "../audit-log.js";
import { redact, redactUrlCredentials } from "../../../foundations/security/redact.js";
import { ProviderRuntime } from "../provider-runtime.js";
import { ProviderConfigStore } from "../config-store/provider-config-store.js";
import { MemoryCredentialStore } from "../credentials/memory-credential-store.js";
import { ModelCatalog } from "../model-catalog.js";

describe("WS0 (SEC-1): Security Redaction in Audit Log and Observability", () => {
  let tempDir: string;
  let auditLogPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "seepient-sec0-test-"));
    auditLogPath = path.join(tempDir, "audit.log");
    process.env.SEEPIENT_AUDIT_LOG_PATH = auditLogPath;
  });

  afterEach(() => {
    delete process.env.SEEPIENT_AUDIT_LOG_PATH;
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("redacts Authorization headers, hyphenated api-keys, and userinfo in URLs", () => {
    const rawData = {
      action: "update_overlay",
      headers: {
        Authorization: "Bearer sk-proj-12345678901234567890abcdef",
        "X-Api-Key": "rk-abcdef1234567890abcdef",
        "x-custom-token": "secret-val",
      },
      baseUrl: "https://admin:hunter2@api.provider.com/v1",
      errorMsg: "Connection failed with sk-ant-12345678901234567890",
      promptTokens: 1500,
      cachedPromptTokens: 200,
    };

    const redacted = redact(rawData);
    expect(redacted.headers.Authorization).toBe("[REDACTED]");
    expect(redacted.headers["X-Api-Key"]).toBe("[REDACTED]");
    expect(redacted.headers["x-custom-token"]).toBe("[REDACTED]");
    expect(redacted.baseUrl).not.toContain("hunter2");
    expect(redacted.baseUrl).toContain("https://api.provider.com/v1");
    expect(redacted.errorMsg).toContain("[REDACTED]");
    expect(redacted.errorMsg).not.toContain("sk-ant-12345678901234567890");
    // Token metrics preserved
    expect(redacted.promptTokens).toBe(1500);
    expect(redacted.cachedPromptTokens).toBe(200);
  });

  it("records audit event without persisting any secret patterns or embedded URL passwords", () => {
    recordProviderAuditEvent({
      timestamp: new Date().toISOString(),
      action: "update_overlay",
      revision: 1,
      details: {
        providers: {
          custom: {
            adapter: "pi-ai",
            baseUrl: "https://user:mysecretpassword@openai.com/v1",
            headers: {
              Authorization: "Bearer sk-proj-9999999999999999999999",
              "x-api-key": "secret-key-value",
            },
            credential: { kind: "api_key", value: "sk-proj-9999999999999999999999" },
          },
        },
      },
    });

    const content = fs.readFileSync(auditLogPath, "utf-8");
    expect(content).not.toContain("mysecretpassword");
    expect(content).not.toContain("sk-proj-9999999999999999999999");
    expect(content).not.toContain("secret-key-value");
    expect(content).toContain("[REDACTED]");
  });

  it("scrubAuditLog sanitizes legacy unredacted lines in-place", () => {
    fs.writeFileSync(
      auditLogPath,
      JSON.stringify({
        timestamp: "2026-01-01T00:00:00.000Z",
        action: "legacy_entry",
        details: {
          key: "sk-proj-oldsecretkey123456789012",
          url: "https://app:hunter3@api.com",
        },
      }) + "\n",
      { mode: 0o600 },
    );

    scrubAuditLog(auditLogPath);

    const scrubbed = fs.readFileSync(auditLogPath, "utf-8");
    expect(scrubbed).not.toContain("sk-proj-oldsecretkey123456789012");
    expect(scrubbed).not.toContain("hunter3");
    expect(scrubbed).toContain("[REDACTED]");
  });

  it("provider runtime plan:resolved emits slim summary without credential secrets", async () => {
    const creds = new MemoryCredentialStore();
    await creds.put("openai_key", { kind: "api_key", keyValue: "sk-proj-12345678901234567890" });

    const overlayPath = path.join(tempDir, "overlay.json");
    const configStore = new ProviderConfigStore(overlayPath);
    await configStore.updateOverlay({
      providers: {
        openai: {
          adapter: "pi-ai",
          upstreamProvider: "openai",
          credential: { kind: "seepient", id: "openai_key" },
        },
      },
      modelAssignments: {
        text: {
          standard: {
            providerAccount: "openai",
            model: "gpt-4o",
          },
        },
      } as any,
    }, 0);
    const catalog = new ModelCatalog();

    const runtime = new ProviderRuntime({
      configStore,
      credentialStore: creds,
      modelCatalog: catalog,
    });

    let emittedEvent: any = null;
    runtime.on("plan:resolved", (e) => {
      emittedEvent = e;
    });

    const snapshot = await runtime.createTurnSnapshot();
    await runtime.resolvePlan(snapshot, "text", "standard");

    expect(emittedEvent).not.toBeNull();
    expect(emittedEvent.purpose).toBe("text");
    expect(emittedEvent.tier).toBe("standard");
    expect(emittedEvent.selectedTarget).toBeDefined();
    // Verify no credential secrets or snapshot configs leaked in the event payload
    const serialized = JSON.stringify(emittedEvent);
    expect(serialized).not.toContain("sk-proj-12345678901234567890");
  });
});
