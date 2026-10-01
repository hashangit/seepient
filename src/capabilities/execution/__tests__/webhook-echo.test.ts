/**
 * US0 red gate (022-5-WO3 T004, pass-13 P2-3): a denied webhook effect must
 * NOT echo the credential-bearing webhook URL into tenant-visible denial
 * output. Feishu/DingTalk/WeCom tokens live in the URL query; the broker's
 * own never-returns-raw-secrets invariant requires redaction. The host may
 * stay (debuggability); the query/auth must not.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EffectBroker, NodeNetworkAdapter } from "../effect-broker.js";
import { InMemoryArtifactStore } from "../in-memory-artifact-store.js";
import type { BrokeredEffectRequest } from "../../../foundations/contracts/prepared-action.js";
import type { CapabilityEnvelope } from "../../../foundations/contracts/permission-policy.js";
import type { BrokerAuthContext } from "../../../foundations/contracts/execution-brokers.js";

const WEBHOOK_URL = "https://hooks.example.com/webhook?token=SECRET-WEBHOOK-TOKEN&key=ALSO-SECRET";

function envelope(): CapabilityEnvelope {
  return {
    version: 1,
    envelopeId: "env",
    principalId: "tenant-a",
    runId: "r1",
    actionDigest: "d1",
    capabilities: [
      { kind: "external-recipient", service: "feishu", recipient: "notify-channel" } as never,
      { kind: "secret-ref", ref: "WH_KEY" },
    ],
    lifetime: { kind: "action", actionDigest: "d1", consumeOnce: true },
    issuedBy: { kind: "service", authorityId: "policy", authenticatedBy: "test" },
    issuedAt: Date.now(),
    policyDigest: "pol",
  };
}

function auth(): BrokerAuthContext {
  return {
    leaseId: "lease-1",
    actionDigest: "d1",
    singleUseRequestId: "req-wh-1",
    expiresAt: Date.now() + 60_000,
  };
}

function webhookRequest(): BrokeredEffectRequest {
  // The broker dispatches notification webhooks by `service` — the webhook
  // URL comes from the OPERATOR's resolver (Feishu/DingTalk/WeCom key), so
  // the leak vector is the denial echoing that operator URL to the tenant.
  return {
    kind: "external-send",
    service: "feishu",
    requestId: "req-wh-1",
    recipients: [{ service: "feishu", recipient: "notify-channel" }],
    text: "notify",
    secretRefs: [],
  } as never;
}

describe("webhook denial redaction (022-5-WO3 T004)", () => {
  const originalEnv = process.env;
  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.WH_KEY = "sk-broker-secret";
  });
  afterEach(() => {
    process.env = originalEnv;
  });

  async function deniedMessage(): Promise<string> {
    const broker = new EffectBroker({
      artifacts: new InMemoryArtifactStore(),
      network: new NodeNetworkAdapter(),
      tenancyMode: "multi",
      // The operator's resolver supplies the credential-bearing webhook URL.
      secretResolver: (ref: string) => (ref.endsWith("Webhook") ? WEBHOOK_URL : "kw"),
    });
    const result = await broker.execute(webhookRequest(), envelope(), auth());
    expect(result.status).toBe("denied");
    return (result as { error?: { message?: string }; reason?: string }).error?.message
      ?? (result as { reason?: string }).reason
      ?? JSON.stringify(result);
  }

  it("a SSRF-denied webhook effect does not leak the URL's query/auth into the denial", async () => {
    const message = await deniedMessage();
    expect(message).toMatch(/DESTINATION_DENIED/);
    expect(message).not.toContain("SECRET-WEBHOOK-TOKEN");
    expect(message).not.toContain("ALSO-SECRET");
    // Host is fine for debuggability.
    expect(message).toContain("hooks.example.com");
  });

  it("a malformed webhook URL does not leak the query/auth either", async () => {
    let resolveCount = 0;
    const broker = new EffectBroker({
      artifacts: new InMemoryArtifactStore(),
      network: new NodeNetworkAdapter(),
      tenancyMode: "multi",
      secretResolver: (ref: string) => {
        resolveCount += 1;
        return ref.endsWith("Webhook") ? "not a url at all?token=SECRET-WEBHOOK-TOKEN" : "kw";
      },
    });
    void resolveCount;
    const bad = webhookRequest();
    const result = await broker.execute(bad, envelope(), auth());
    expect(result.status).toBe("denied");
    const message = (result as { error?: { message?: string }; reason?: string }).error?.message
      ?? (result as { reason?: string }).reason
      ?? JSON.stringify(result);
    expect(message).not.toContain("SECRET-WEBHOOK-TOKEN");
  });
});
