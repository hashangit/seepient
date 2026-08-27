/**
 * P2 effect broker security tests (spec 008, T209/T210, QS-2.6/QS-2.10).
 *
 * Verifies: replay protection, private/metadata address denial, DNS
 * rebinding defense, redirect reauthorization, header injection prevention,
 * secret-value isolation, and single-use request IDs.
 */
import { describe, it, expect } from "vitest";
import { EffectBroker } from "../effect-broker.js";
import { InMemoryArtifactStore } from "../in-memory-artifact-store.js";
import type { BrokerNetworkAdapter, BrokerNetworkResponse } from "../effect-broker.js";
import type {
  BrokeredEffectRequest,
} from "../../../foundations/contracts/prepared-action.js";
import type {
  CapabilityEnvelope,
} from "../../../foundations/contracts/permission-policy.js";
import type { NetworkDestination } from "../../../foundations/contracts/tool-effects.js";

function envelope(host: string): CapabilityEnvelope {
  return {
    version: 1,
    envelopeId: "e1",
    principalId: "u",
    runId: "r1",
    actionDigest: "d1",
    capabilities: [
      { kind: "network-destination", scheme: "https", host },
    ],
    lifetime: { kind: "action", actionDigest: "d1", consumeOnce: true },
    issuedBy: { kind: "service", authorityId: "pe", authenticatedBy: "deployment" },
    issuedAt: 0,
    policyDigest: "dig",
  };
}

function auth(overrides: Partial<{ expiresAt: number; actionDigest: string; singleUseRequestId: string }> = {}) {
  return {
    leaseId: "l1",
    actionDigest: overrides.actionDigest ?? "d1",
    expiresAt: overrides.expiresAt ?? Date.now() + 60_000,
    singleUseRequestId: overrides.singleUseRequestId ?? "br-1",
  };
}

function httpReq(destination: NetworkDestination, requestId = "br-1"): BrokeredEffectRequest {
  return {
    kind: "http",
    requestId,
    destination,
    method: "GET",
    headers: {},
    secretRefs: [],
  };
}

/** Build a fake network adapter with configurable resolve + fetch. */
function fakeNetwork(opts: {
  ips?: string[];
  effectiveIp?: string;
  fetchBytes?: Uint8Array;
  fetchStatus?: number;
  fetchThrows?: boolean;
  /** Headers returned on fetch (lower-cased keys). Used for redirect tests. */
  fetchHeaders?: Record<string, string>;
}): BrokerNetworkAdapter {
  return {
    async resolve(host: string) {
      void host;
      return opts.ips ?? ["93.184.216.34"]; // example.com
    },
    async fetch(destination, init): Promise<BrokerNetworkResponse> {
      void destination;
      void init;
      if (opts.fetchThrows) throw new Error("network down");
      return {
        status: opts.fetchStatus ?? 200,
        bytes: opts.fetchBytes ?? new Uint8Array([0x68, 0x69]),
        effectiveHost: destination.host,
        effectiveIp: opts.effectiveIp ?? opts.ips?.[0] ?? "93.184.216.34",
        headers: opts.fetchHeaders ?? {},
      };
    },
  };
}

describe("EffectBroker (T209/T210, QS-2.6)", () => {
  it("allows a permitted HTTPS destination", async () => {
    const broker = new EffectBroker({
      artifacts: new InMemoryArtifactStore(),
      network: fakeNetwork({}),
    });
    const result = await broker.execute(
      httpReq({ scheme: "https", host: "api.example.com" }),
      envelope("api.example.com"),
      auth(),
    );
    expect(result.status).toBe("succeeded");
    expect(result.output).toBeDefined();
  });

  it("denies when envelope lacks capability for the destination", async () => {
    const broker = new EffectBroker({
      artifacts: new InMemoryArtifactStore(),
      network: fakeNetwork({}),
    });
    const result = await broker.execute(
      httpReq({ scheme: "https", host: "evil.example.com" }),
      envelope("api.example.com"), // different host
      auth(),
    );
    expect(result.status).toBe("denied");
  });

  it("denies loopback addresses", async () => {
    const broker = new EffectBroker({
      artifacts: new InMemoryArtifactStore(),
      network: fakeNetwork({ ips: ["127.0.0.1"] }),
    });
    const result = await broker.execute(
      httpReq({ scheme: "https", host: "localhost.rebind.example.com" }),
      envelope("localhost.rebind.example.com"),
      auth(),
    );
    expect(result.status).toBe("denied");
  });

  it("denies private ranges (10.x, 192.168.x, 172.16-31.x)", async () => {
    for (const ip of ["10.0.0.1", "192.168.1.1", "172.16.0.1", "172.31.255.255"]) {
      const broker = new EffectBroker({
        artifacts: new InMemoryArtifactStore(),
        network: fakeNetwork({ ips: [ip] }),
      });
      const result = await broker.execute(
        httpReq({ scheme: "https", host: "internal.example.com" }),
        envelope("internal.example.com"),
        auth(),
      );
      expect(result.status, `${ip} should be denied`).toBe("denied");
    }
  });

  it("denies cloud metadata addresses (literal + host)", async () => {
    const broker = new EffectBroker({
      artifacts: new InMemoryArtifactStore(),
      network: fakeNetwork({ ips: ["169.254.169.254"] }),
    });
    const result = await broker.execute(
      httpReq({ scheme: "https", host: "169.254.169.254" }),
      envelope("169.254.169.254"),
      auth(),
    );
    expect(result.status).toBe("denied");
  });

  it("denies DNS rebinding (effective IP differs from resolved)", async () => {
    const broker = new EffectBroker({
      artifacts: new InMemoryArtifactStore(),
      network: fakeNetwork({ ips: ["93.184.216.34"], effectiveIp: "127.0.0.1" }),
    });
    const result = await broker.execute(
      httpReq({ scheme: "https", host: "rebind.example.com" }),
      envelope("rebind.example.com"),
      auth(),
    );
    expect(result.status).toBe("denied");
  });

  it("strips forbidden headers (authorization/cookie/host/proxy/forwarded)", async () => {
    let capturedHeaders: Record<string, string> = {};
    const network: BrokerNetworkAdapter = {
      async resolve() {
        return ["93.184.216.34"];
      },
      async fetch(_d, init) {
        capturedHeaders = init.headers;
        return { status: 200, bytes: new Uint8Array([1]), effectiveHost: _d.host, effectiveIp: "93.184.216.34", headers: {} };
      },
    };
    const broker = new EffectBroker({ artifacts: new InMemoryArtifactStore(), network });
    await broker.execute(
      {
        kind: "http",
        requestId: "req-headers-1",
        destination: { scheme: "https", host: "api.example.com" },
        method: "GET",
        headers: {
          Authorization: "Bearer evil",
          Cookie: "session=x",
          Host: "fake.example.com",
          "X-Forwarded-For": "spoofed",
          "User-Agent": "ok",
        },
        secretRefs: [],
      },
      envelope("api.example.com"),
      auth({ singleUseRequestId: "req-headers-1" }),
    );
    expect(capturedHeaders.Authorization).toBeUndefined();
    expect(capturedHeaders.Cookie).toBeUndefined();
    expect(capturedHeaders.Host).toBeUndefined();
    expect(capturedHeaders["X-Forwarded-For"]).toBeUndefined();
    expect(capturedHeaders["User-Agent"]).toBe("ok");
  });

  it("replays the same single-use request ID → denied", async () => {
    const broker = new EffectBroker({
      artifacts: new InMemoryArtifactStore(),
      network: fakeNetwork({}),
    });
    const a = await broker.execute(
      httpReq({ scheme: "https", host: "api.example.com" }, "nonce-1"),
      envelope("api.example.com"),
      auth({ singleUseRequestId: "nonce-1" }),
    );
    expect(a.status).toBe("succeeded");
    const b = await broker.execute(
      httpReq({ scheme: "https", host: "api.example.com" }, "nonce-1"),
      envelope("api.example.com"),
      auth({ singleUseRequestId: "nonce-1" }),
    );
    expect(b.status).toBe("denied");
  });

  it("expired lease → denied", async () => {
    const broker = new EffectBroker({
      artifacts: new InMemoryArtifactStore(),
      network: fakeNetwork({}),
    });
    const result = await broker.execute(
      httpReq({ scheme: "https", host: "api.example.com" }),
      envelope("api.example.com"),
      auth({ expiresAt: Date.now() - 1 }),
    );
    expect(result.status).toBe("denied");
  });

  it("lease/action digest mismatch → denied", async () => {
    const broker = new EffectBroker({
      artifacts: new InMemoryArtifactStore(),
      network: fakeNetwork({}),
    });
    const result = await broker.execute(
      httpReq({ scheme: "https", host: "api.example.com" }),
      envelope("api.example.com"),
      auth({ actionDigest: "different-action" }),
    );
    expect(result.status).toBe("denied");
  });

  it("non-HTTP scheme → denied", async () => {
    const broker = new EffectBroker({
      artifacts: new InMemoryArtifactStore(),
      network: fakeNetwork({}),
    });
    const result = await broker.execute(
      {
        kind: "http",
        requestId: "br-1",
        // FTP is intentionally outside the `"https" | "http"` union so this
        // exercises the broker's non-HTTP-scheme rejection path. Cast through
        // `unknown` because the rejection itself is the point of the test.
        destination: { scheme: "ftp", host: "files.example.com" } as unknown as NetworkDestination,
        method: "GET",
        headers: {},
        secretRefs: [],
      },
      envelope("files.example.com"),
      auth(),
    );
    expect(result.status).toBe("denied");
  });

  it("oversized response → denied", async () => {
    const broker = new EffectBroker({
      artifacts: new InMemoryArtifactStore(),
      network: fakeNetwork({ fetchBytes: new Uint8Array(11 * 1024 * 1024) }),
      maxResponseBytes: 1024 * 1024,
    });
    const result = await broker.execute(
      httpReq({ scheme: "https", host: "big.example.com" }),
      envelope("big.example.com"),
      auth(),
    );
    expect(result.status).toBe("denied");
  });

  it("follows a redirect to a destination the envelope authorizes", async () => {
    // First fetch returns 302 to cdn.example.com; second fetch returns 200.
    let calls = 0;
    const network: BrokerNetworkAdapter = {
      async resolve(host: string) {
        // Both hosts resolve to a public IP.
        return ["93.184.216.34"];
      },
      async fetch(destination): Promise<BrokerNetworkResponse> {
        calls++;
        if (calls === 1) {
          return {
            status: 302,
            bytes: new Uint8Array(0),
            effectiveHost: destination.host,
            effectiveIp: "93.184.216.34",
            headers: { location: "https://cdn.example.com/asset" },
          };
        }
        return {
          status: 200,
          bytes: new Uint8Array([0x6f, 0x6b]),
          effectiveHost: destination.host,
          effectiveIp: "93.184.216.34",
          headers: {},
        };
      },
    };
    const broker = new EffectBroker({ artifacts: new InMemoryArtifactStore(), network });
    const env: CapabilityEnvelope = {
      ...envelope("api.example.com"),
      capabilities: [
        { kind: "network-destination", scheme: "https", host: "api.example.com" },
        { kind: "network-destination", scheme: "https", host: "cdn.example.com" },
      ],
    };
    const result = await broker.execute(
      httpReq({ scheme: "https", host: "api.example.com" }, "req-redirect-ok"),
      env,
      auth({ singleUseRequestId: "req-redirect-ok" }),
    );
    expect(calls).toBe(2); // original + redirect target
    expect(result.status).toBe("succeeded");
  });

  it("denies a redirect to a destination the envelope does NOT authorize", async () => {
    let calls = 0;
    const network: BrokerNetworkAdapter = {
      async resolve() {
        return ["93.184.216.34"];
      },
      async fetch(destination) {
        calls++;
        return {
          status: 302,
          bytes: new Uint8Array(0),
          effectiveHost: destination.host,
          effectiveIp: "93.184.216.34",
          headers: { location: "https://evil.example.com/steal" },
        };
      },
    };
    const broker = new EffectBroker({ artifacts: new InMemoryArtifactStore(), network });
    const result = await broker.execute(
      httpReq({ scheme: "https", host: "api.example.com" }, "req-redirect-deny"),
      envelope("api.example.com"), // NO cap for evil.example.com
      auth({ singleUseRequestId: "req-redirect-deny" }),
    );
    expect(calls).toBe(1); // no second fetch attempted
    expect(result.status).toBe("denied");
    expect(result.error?.message).toMatch(/evil\.example\.com/);
  });

  it("a 303 redirect converts POST to GET and drops the body (no payload leak)", async () => {
    // Regression guard: the broker must not re-post a secret-bearing body to a
    // redirect target. RFC 7231 §6.4.4 — 303 → GET, no body.
    const calls: { method: string; hadBody: boolean }[] = [];
    const network: BrokerNetworkAdapter = {
      async resolve() {
        return ["93.184.216.34"];
      },
      async fetch(destination, init): Promise<BrokerNetworkResponse> {
        calls.push({ method: init.method, hadBody: !!init.body && init.body.length > 0 });
        if (calls.length === 1) {
          return {
            status: 303,
            bytes: new Uint8Array(0),
            effectiveHost: destination.host,
            effectiveIp: "93.184.216.34",
            headers: { location: "https://cdn.example.com/result" },
          };
        }
        return {
          status: 200,
          bytes: new Uint8Array([0x6f, 0x6b]),
          effectiveHost: destination.host,
          effectiveIp: "93.184.216.34",
          headers: {},
        };
      },
    };
    const broker = new EffectBroker({ artifacts: new InMemoryArtifactStore(), network });
    // The request is a POST with a body artifact in the broker's own store.
    const brokerArtifacts = new InMemoryArtifactStore();
    const bodyRef = await brokerArtifacts.put(new Uint8Array([0x73, 0x65, 0x63, 0x72, 0x65, 0x74]), "application/octet-stream");
    // Use the broker's own artifact store so the body resolves.
    const brokerWithBody = new EffectBroker({ artifacts: brokerArtifacts, network });
    const env: CapabilityEnvelope = {
      ...envelope("api.example.com"),
      capabilities: [
        { kind: "network-destination", scheme: "https", host: "api.example.com" },
        { kind: "network-destination", scheme: "https", host: "cdn.example.com" },
      ],
    };
    await brokerWithBody.execute(
      {
        kind: "http",
        requestId: "req-post-303",
        destination: { scheme: "https", host: "api.example.com" },
        method: "POST",
        headers: {},
        body: bodyRef,
        secretRefs: [],
      },
      env,
      auth({ singleUseRequestId: "req-post-303" }),
    );
    void broker;
    expect(calls).toHaveLength(2);
    // First call is the original POST with a body.
    expect(calls[0]).toEqual({ method: "POST", hadBody: true });
    // Second call (after 303) MUST be GET with NO body — the body must not
    // leak to the redirect target host.
    expect(calls[1]).toEqual({ method: "GET", hadBody: false });
  });

  it("a 307 redirect preserves the POST method and body", async () => {
    // RFC 7231 §6.4.7 — 307 preserves method and body.
    const calls: { method: string; hadBody: boolean }[] = [];
    const network: BrokerNetworkAdapter = {
      async resolve() {
        return ["93.184.216.34"];
      },
      async fetch(destination, init): Promise<BrokerNetworkResponse> {
        calls.push({ method: init.method, hadBody: !!init.body && init.body.length > 0 });
        if (calls.length === 1) {
          return {
            status: 307,
            bytes: new Uint8Array(0),
            effectiveHost: destination.host,
            effectiveIp: "93.184.216.34",
            headers: { location: "https://cdn.example.com/result" },
          };
        }
        return {
          status: 200,
          bytes: new Uint8Array([0x6f, 0x6b]),
          effectiveHost: destination.host,
          effectiveIp: "93.184.216.34",
          headers: {},
        };
      },
    };
    const brokerArtifacts = new InMemoryArtifactStore();
    const bodyRef = await brokerArtifacts.put(new Uint8Array([0x73, 0x65, 0x63, 0x72, 0x65, 0x74]), "application/octet-stream");
    const broker = new EffectBroker({ artifacts: brokerArtifacts, network });
    const env: CapabilityEnvelope = {
      ...envelope("api.example.com"),
      capabilities: [
        { kind: "network-destination", scheme: "https", host: "api.example.com" },
        { kind: "network-destination", scheme: "https", host: "cdn.example.com" },
      ],
    };
    await broker.execute(
      {
        kind: "http",
        requestId: "req-post-307",
        destination: { scheme: "https", host: "api.example.com" },
        method: "POST",
        headers: {},
        body: bodyRef,
        secretRefs: [],
      },
      env,
      auth({ singleUseRequestId: "req-post-307" }),
    );
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ method: "POST", hadBody: true });
    // 307 preserves POST and body.
    expect(calls[1]).toEqual({ method: "POST", hadBody: true });
  });

  it("a redirect chain exceeding MAX_REDIRECTS is denied, not silently succeeded", async () => {
    // Every fetch returns a 302 → the broker must stop after MAX_REDIRECTS and
    // return a denial rather than treating the final 3xx body as a success.
    let calls = 0;
    const network: BrokerNetworkAdapter = {
      async resolve() {
        return ["93.184.216.34"];
      },
      async fetch(destination) {
        calls++;
        return {
          status: 302,
          bytes: new Uint8Array([0x78]),
          effectiveHost: destination.host,
          effectiveIp: "93.184.216.34",
          headers: { location: `https://cdn.example.com/loop-${calls}` },
        };
      },
    };
    const broker = new EffectBroker({ artifacts: new InMemoryArtifactStore(), network });
    const env: CapabilityEnvelope = {
      ...envelope("api.example.com"),
      capabilities: [
        { kind: "network-destination", scheme: "https", host: "api.example.com" },
        { kind: "network-destination", scheme: "https", host: "cdn.example.com" },
      ],
    };
    const result = await broker.execute(
      httpReq({ scheme: "https", host: "api.example.com" }, "req-redirect-loop"),
      env,
      auth({ singleUseRequestId: "req-redirect-loop" }),
    );
    expect(result.status).toBe("denied");
    expect(result.error?.message).toMatch(/exceeded|redirect/i);
    // The broker caps the chain — it does not loop forever.
    expect(calls).toBeLessThanOrEqual(6);
  });
});
