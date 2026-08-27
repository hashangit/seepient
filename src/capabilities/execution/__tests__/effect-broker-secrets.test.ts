import { describe, it, expect, vi, beforeEach } from "vitest";
import { EffectBroker, type BrokerNetworkAdapter } from "../effect-broker.js";
import { InMemoryArtifactStore } from "../in-memory-artifact-store.js";
import type { BrokeredEffectRequest } from "../../../foundations/contracts/prepared-action.js";
import type { CapabilityEnvelope } from "../../../foundations/contracts/permission-policy.js";
import type { BrokerAuthContext } from "../../../foundations/contracts/execution-brokers.js";

describe("EffectBroker credential resolution & auth headers (P0-1)", () => {
  let artifacts: InMemoryArtifactStore;

  beforeEach(() => {
    artifacts = new InMemoryArtifactStore();
  });

  it("injects Authorization Bearer for Tavily requests and keeps the key out of the body", async () => {
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: Uint8Array | undefined;
    const broker = new EffectBroker({
      artifacts,
      network: {
        resolve: vi.fn().mockResolvedValue(["93.184.216.34"]),
        fetch: async (target, init) => {
          capturedHeaders = (init.headers as Record<string, string>) || {};
          capturedBody = init.body;
          return {
            status: 200,
            headers: {},
            bytes: new TextEncoder().encode(JSON.stringify({ results: [] })),
            effectiveHost: target.host,
            effectiveIp: "93.184.216.34",
          };
        },
      },
      secretResolver: (ref) => {
        if (ref === "tavilyApiKey") return "tvly-secret-12345";
        return undefined;
      },
    });

    const bodyArtifact = await artifacts.put(
      new TextEncoder().encode(JSON.stringify({ query: "vitest test" })),
      "application/json",
    );

    const request: BrokeredEffectRequest = {
      kind: "http",
      requestId: "req-tavily-1",
      method: "POST",
      destination: { scheme: "https", host: "api.tavily.com" },
      headers: {
        "content-type": "application/json",
        cookie: "session=malicious", // forbidden header that MUST be stripped
        authorization: "Bearer attacker-spoofed-key", // forbidden header that MUST be stripped and replaced
      },
      body: bodyArtifact,
      secretRefs: ["tavilyApiKey"],
    };

    const envelope: CapabilityEnvelope = {
      version: 1,
      envelopeId: "env-1",
      principalId: "user-1",
      runId: "run-1",
      actionDigest: "digest-1",
      capabilities: [
        { kind: "network-destination", scheme: "https", host: "api.tavily.com" },
        { kind: "secret-ref", ref: "tavilyApiKey" },
      ],
      lifetime: { kind: "action", actionDigest: "digest-1", consumeOnce: true },
      issuedBy: { kind: "service", authorityId: "policy-engine", authenticatedBy: "test" },
      issuedAt: Date.now(),
      policyDigest: "pol-1",
    };

    const auth: BrokerAuthContext = {
      leaseId: "lease-1",
      actionDigest: "digest-1",
      singleUseRequestId: "req-tavily-1",
      expiresAt: Date.now() + 60_000,
    };

    const result = await broker.execute(request, envelope, auth);
    expect(result.status).toBe("succeeded");

    // Verify forbidden headers were stripped and replaced with the resolved authorized secret
    expect(capturedHeaders.cookie).toBeUndefined();
    expect(capturedHeaders.authorization).toBe("Bearer tvly-secret-12345");

    // Tavily auth is Bearer-only per their API reference: the key must not be
    // duplicated into other headers or the request body (secret-surface reduction).
    expect(capturedHeaders["api-key"]).toBeUndefined();
    expect(capturedBody).toBeDefined();
    const bodyJson = JSON.parse(new TextDecoder().decode(capturedBody!));
    expect(bodyJson.query).toBe("vitest test");
    expect(bodyJson.api_key).toBeUndefined();
    expect(JSON.stringify(bodyJson)).not.toContain("tvly-secret-12345");
  });

  it("injects OpenAI API key into Authorization header for image/prompt endpoints", async () => {
    let capturedHeaders: Record<string, string> = {};

    const mockNetwork: BrokerNetworkAdapter = {
      resolve: vi.fn().mockResolvedValue(["104.18.6.192"]),
      fetch: vi.fn().mockImplementation(async (_dest, init) => {
        capturedHeaders = init.headers;
        return {
          status: 200,
          bytes: new TextEncoder().encode(JSON.stringify({ data: [{ url: "https://example.com/img.png" }] })),
          effectiveHost: "api.openai.com",
          effectiveIp: "104.18.6.192",
          headers: { "content-type": "application/json" },
        };
      }),
    };

    const broker = new EffectBroker({
      artifacts,
      network: mockNetwork,
      secretResolver: (ref) => (ref === "openaiApiKey" || ref === "OPENAI_API_KEY" ? "sk-openai-key-999" : undefined),
    });

    const bodyArtifact = await artifacts.put(
      new TextEncoder().encode(JSON.stringify({ prompt: "cyberpunk cat" })),
      "application/json",
    );

    const request: BrokeredEffectRequest = {
      kind: "http",
      requestId: "req-openai-1",
      method: "POST",
      destination: { scheme: "https", host: "api.openai.com" },
      headers: { "content-type": "application/json" },
      body: bodyArtifact,
      secretRefs: ["OPENAI_API_KEY"],
    };

    const envelope: CapabilityEnvelope = {
      version: 1,
      envelopeId: "env-2",
      principalId: "user-1",
      runId: "run-1",
      actionDigest: "digest-2",
      capabilities: [
        { kind: "network-destination", scheme: "https", host: "api.openai.com" },
        { kind: "secret-ref", ref: "OPENAI_API_KEY" },
      ],
      lifetime: { kind: "action", actionDigest: "digest-2", consumeOnce: true },
      issuedBy: { kind: "service", authorityId: "policy-engine", authenticatedBy: "test" },
      issuedAt: Date.now(),
      policyDigest: "pol-1",
    };

    const auth: BrokerAuthContext = {
      leaseId: "lease-2",
      actionDigest: "digest-2",
      singleUseRequestId: "req-openai-1",
      expiresAt: Date.now() + 60_000,
    };

    const result = await broker.execute(request, envelope, auth);
    expect(result.status).toBe("succeeded");
    expect(capturedHeaders.authorization).toBe("Bearer sk-openai-key-999");
  });

  it("executes external-send with wildcard recipient capabilities", async () => {
    let capturedReq: any;
    const broker = new EffectBroker({
      artifacts,
      network: {
        resolve: vi.fn(),
        fetch: vi.fn(),
      },
      externalSendHandler: async (req) => {
        capturedReq = req;
        return {
          requestId: req.requestId,
          status: "succeeded",
          output: "art-1" as any,
        };
      },
    });

    const bodyArtifact = await artifacts.put(new TextEncoder().encode("email body"), "text/plain");
    const request: BrokeredEffectRequest = {
      kind: "external-send",
      requestId: "req-send-1",
      service: "smtp",
      recipients: [{ service: "smtp", recipient: "test@example.com" }],
      payload: bodyArtifact,
      secretRefs: ["smtpHost"],
    };

    const envelope: CapabilityEnvelope = {
      version: 1,
      envelopeId: "env-3",
      principalId: "user-1",
      runId: "run-1",
      actionDigest: "digest-3",
      capabilities: [
        { kind: "external-recipient", service: "*", recipient: "*" },
      ],
      lifetime: { kind: "action", actionDigest: "digest-3", consumeOnce: true },
      issuedBy: { kind: "service", authorityId: "policy-engine", authenticatedBy: "test" },
      issuedAt: Date.now(),
      policyDigest: "pol-1",
    };

    const auth: BrokerAuthContext = {
      leaseId: "lease-3",
      actionDigest: "digest-3",
      singleUseRequestId: "req-send-1",
      expiresAt: Date.now() + 60_000,
    };

    const result = await broker.execute(request, envelope, auth);
    expect(result.status).toBe("succeeded");
    expect(capturedReq.service).toBe("smtp");
  });

  it("strips authorization and api-key headers on cross-host redirect (P0-B)", async () => {
    const hopHeaders: Record<string, string>[] = [];
    const broker = new EffectBroker({
      artifacts,
      network: {
        resolve: vi.fn().mockResolvedValue(["93.184.216.34"]),
        fetch: async (target, init) => {
          hopHeaders.push({ ...(init.headers as Record<string, string>) });
          if (target.host === "api.tavily.com") {
            return {
              status: 302,
              headers: { location: "https://other.example.com/result" } as Record<string, string>,
              bytes: new Uint8Array(),
              effectiveHost: "api.tavily.com",
              effectiveIp: "93.184.216.34",
            };
          }
          return {
            status: 200,
            headers: {} as Record<string, string>,
            bytes: new TextEncoder().encode("ok"),
            effectiveHost: "other.example.com",
            effectiveIp: "93.184.216.34",
          };
        },
      },
      secretResolver: (ref) => (ref === "tavilyApiKey" ? "tvly-secret-12345" : undefined),
    });

    const request: BrokeredEffectRequest = {
      kind: "http",
      requestId: "req-redir-1",
      destination: { scheme: "https", host: "api.tavily.com" },
      method: "GET",
      headers: { "user-agent": "test" },
      secretRefs: ["tavilyApiKey"],
    };

    const envelope: CapabilityEnvelope = {
      version: 1,
      envelopeId: "env-redir",
      principalId: "user-1",
      runId: "run-1",
      actionDigest: "digest-redir",
      capabilities: [
        { kind: "network-destination", scheme: "https", host: "*" },
        { kind: "secret-ref", ref: "tavilyApiKey" },
      ],
      lifetime: { kind: "action", actionDigest: "digest-redir", consumeOnce: true },
      issuedBy: { kind: "service", authorityId: "policy-engine", authenticatedBy: "test" },
      issuedAt: Date.now(),
      policyDigest: "pol-1",
    };

    const auth: BrokerAuthContext = {
      leaseId: "lease-redir",
      actionDigest: "digest-redir",
      singleUseRequestId: "req-redir-1",
      expiresAt: Date.now() + 60_000,
    };

    const result = await broker.execute(request, envelope, auth);
    expect(result.status).toBe("succeeded");
    expect(hopHeaders).toHaveLength(2);
    // First hop (api.tavily.com) carries the Bearer credential
    expect(hopHeaders[0].authorization).toBe("Bearer tvly-secret-12345");
    // Second hop (other.example.com) MUST NOT carry credentials
    expect(hopHeaders[1].authorization).toBeUndefined();
    expect(hopHeaders[1]["api-key"]).toBeUndefined();
    expect(hopHeaders[1]["user-agent"]).toBe("test");
  });

  it("refuses 307 redirect with secret-bearing payload to cross-host destination (P0-B)", async () => {
    const broker = new EffectBroker({
      artifacts,
      network: {
        resolve: vi.fn().mockResolvedValue(["93.184.216.34"]),
        fetch: async (target) => {
          if (target.host === "api.tavily.com") {
            return {
              status: 307,
              headers: { location: "https://other.example.com/result" } as Record<string, string>,
              bytes: new Uint8Array(),
              effectiveHost: "api.tavily.com",
              effectiveIp: "93.184.216.34",
            };
          }
          return {
            status: 200,
            headers: {} as Record<string, string>,
            bytes: new TextEncoder().encode("ok"),
            effectiveHost: "other.example.com",
            effectiveIp: "93.184.216.34",
          };
        },
      },
      secretResolver: (ref) => (ref === "tavilyApiKey" ? "tvly-secret-12345" : undefined),
    });

    const bodyArtifact = await artifacts.put(
      new TextEncoder().encode(JSON.stringify({ query: "test query" })),
      "application/json",
    );

    const request: BrokeredEffectRequest = {
      kind: "http",
      requestId: "req-redir-307",
      destination: { scheme: "https", host: "api.tavily.com" },
      method: "POST",
      headers: { "content-type": "application/json" },
      body: bodyArtifact,
      secretRefs: ["tavilyApiKey"],
    };

    const envelope: CapabilityEnvelope = {
      version: 1,
      envelopeId: "env-307",
      principalId: "user-1",
      runId: "run-1",
      actionDigest: "digest-307",
      capabilities: [
        { kind: "network-destination", scheme: "https", host: "*" },
        { kind: "secret-ref", ref: "tavilyApiKey" },
      ],
      lifetime: { kind: "action", actionDigest: "digest-307", consumeOnce: true },
      issuedBy: { kind: "service", authorityId: "policy-engine", authenticatedBy: "test" },
      issuedAt: Date.now(),
      policyDigest: "pol-1",
    };

    const auth: BrokerAuthContext = {
      leaseId: "lease-307",
      actionDigest: "digest-307",
      singleUseRequestId: "req-redir-307",
      expiresAt: Date.now() + 60_000,
    };

    const result = await broker.execute(request, envelope, auth);
    expect(result.status).toBe("denied");
    expect(result.error?.message).toMatch(/refusing to forward secret-bearing body/);
  });
});
