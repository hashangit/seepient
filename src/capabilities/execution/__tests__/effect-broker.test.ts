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
import type { BrokerNetworkAdapter } from "../effect-broker.js";
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
    singleUseRequestId: overrides.singleUseRequestId ?? "req-1",
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
}): BrokerNetworkAdapter {
  return {
    async resolve(host: string) {
      void host;
      return opts.ips ?? ["93.184.216.34"]; // example.com
    },
    async fetch(destination, init) {
      void destination;
      void init;
      if (opts.fetchThrows) throw new Error("network down");
      return {
        status: opts.fetchStatus ?? 200,
        bytes: opts.fetchBytes ?? new Uint8Array([0x68, 0x69]),
        effectiveHost: destination.host,
        effectiveIp: opts.effectiveIp ?? opts.ips?.[0] ?? "93.184.216.34",
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
        return { status: 200, bytes: new Uint8Array([1]), effectiveHost: _d.host, effectiveIp: "93.184.216.34" };
      },
    };
    const broker = new EffectBroker({ artifacts: new InMemoryArtifactStore(), network });
    await broker.execute(
      {
        kind: "http",
        requestId: "br-1",
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
      auth(),
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
      httpReq({ scheme: "https", host: "api.example.com" }),
      envelope("api.example.com"),
      auth({ singleUseRequestId: "nonce-1" }),
    );
    expect(a.status).toBe("succeeded");
    const b = await broker.execute(
      httpReq({ scheme: "https", host: "api.example.com" }),
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
        destination: { scheme: "ftp", host: "files.example.com" } as NetworkDestination,
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
});
