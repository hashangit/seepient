/**
 * Broker SSRF classifier parity (021-4 W141) + cross-host redirect header
 * hygiene (W143).
 *
 * W141: the broker must deny exactly the address set the foundations byte
 * classifier blocks — the regex lists it used before missed hex-mapped
 * (`::ffff:7f00:1`), v4-compatible (`::127.0.0.1`), NAT64 spellings, and
 * reserved IPv4 ranges (SSDP multicast, 240/4, 192.0.0.0/24, 198.18/15).
 *
 * W143: a credential header sent with mixed case (e.g. `X-Api-Key`) must be
 * stripped on cross-host redirects, not only exact-lowercase names.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EffectBroker, isBrokerDeniedAddress } from "../effect-broker.js";
import { InMemoryArtifactStore } from "../in-memory-artifact-store.js";
import { isPrivateIp, isMetadataIp } from "../../../foundations/network/ip-classifier.js";
import { validateEndpointUrl } from "../../../foundations/network/ssrf-fetch.js";
import type { BrokerNetworkAdapter, BrokerNetworkResponse } from "../effect-broker.js";
import type {
  BrokeredEffectRequest,
} from "../../../foundations/contracts/prepared-action.js";
import type {
  CapabilityEnvelope,
} from "../../../foundations/contracts/permission-policy.js";
import type { NetworkDestination } from "../../../foundations/contracts/tool-effects.js";


// Addresses the byte classifier must block. Includes every spelling the old
// regex lists missed (W141 evidence) plus the classic private/metadata set.
const MUST_DENY = [
  // Loopback spellings
  "127.0.0.1",
  "127.255.255.255",
  "::1",
  "::ffff:127.0.0.1",
  "::ffff:7f00:1", // hex IPv4-mapped loopback — missed by the old regexes
  "::127.0.0.1", // v4-compatible — the shape getaddrinfo renders
  "::7f00:1", // v4-compatible hex — missed by the old regexes
  // Private-use
  "10.1.2.3",
  "192.168.0.1",
  "172.16.0.1",
  "172.31.255.255",
  "::ffff:10.0.0.1",
  "::ffff:a9fe:a9fe", // hex 169.254.169.254 — missed by the old regexes
  // Link-local / metadata
  "169.254.169.254",
  "169.254.10.10",
  "fd00:ec2::254", // AWS IMDSv2 IPv6
  "100.100.100.200", // F5: Alibaba Cloud instance metadata
  "64:ff9b::7f00:1", // NAT64-mapped loopback
  // Reserved / multicast ranges missed by the old regexes (W141 evidence)
  "239.255.255.250", // SSDP multicast — old regex covered only 224/5
  "240.0.0.1", // 240/4 reserved
  "255.255.255.255", // broadcast
  "192.0.0.1", // IETF protocol assignments
  "198.18.0.1", // benchmarking
  "100.64.0.1", // CGNAT
  "0.0.0.0",
  "::",
  "fe80::1",
  "fd12:3456:789a::1",
  "ff02::1",
];

// Addresses that must remain allowed (public) — guards against deny-all drift.
const MUST_ALLOW = ["93.184.216.34", "8.8.8.8", "1.1.1.1", "2606:4700::1111"];

function envelopeFor(host: string): CapabilityEnvelope {
  return {
    version: 1,
    envelopeId: "e1",
    principalId: "u",
    runId: "r1",
    actionDigest: "d1",
    capabilities: [{ kind: "network-destination", scheme: "https", host }],
    lifetime: { kind: "action", actionDigest: "d1", consumeOnce: true },
    issuedBy: { kind: "service", authorityId: "pe", authenticatedBy: "deployment" },
    issuedAt: 0,
    policyDigest: "dig",
  };
}

function auth(requestId = "br-1") {
  return {
    leaseId: "l1",
    actionDigest: "d1",
    expiresAt: Date.now() + 60_000,
    singleUseRequestId: requestId,
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

function fakeNetwork(ips: string[]): BrokerNetworkAdapter {
  return {
    async resolve() {
      return ips;
    },
    async fetch(destination): Promise<BrokerNetworkResponse> {
      return {
        status: 200,
        bytes: new Uint8Array([0x6f, 0x6b]),
        effectiveHost: destination.host,
        effectiveIp: ips[0],
        headers: {},
      };
    },
  };
}

describe("W141 — broker denial equals the foundations byte classifier", () => {
  it("denies every reserved/private/metadata spelling through the broker", async () => {
    for (const ip of MUST_DENY) {
      expect(isBrokerDeniedAddress(ip), `isBrokerDeniedAddress(${ip})`).toBe(true);
      expect(isPrivateIp(ip) || isMetadataIp(ip), `classifier(${ip})`).toBe(true);

      const broker = new EffectBroker({
        artifacts: new InMemoryArtifactStore(),
        network: fakeNetwork([ip]),
      });
      const result = await broker.execute(
        httpReq({ scheme: "https", host: "internal.example.com" }),
        envelopeFor("internal.example.com"),
        auth(`req-${ip.replace(/[^a-z0-9]+/gi, "-")}`),
      );
      expect(result.status, `broker(${ip})`).toBe("denied");
    }
  });

  it("still allows public addresses", async () => {
    for (const ip of MUST_ALLOW) {
      expect(isBrokerDeniedAddress(ip), `isBrokerDeniedAddress(${ip})`).toBe(false);

      const broker = new EffectBroker({
        artifacts: new InMemoryArtifactStore(),
        network: fakeNetwork([ip]),
      });
      const requestId = `req-allow-${ip.replace(/[^a-z0-9]+/gi, "-")}`;
      const result = await broker.execute(
        httpReq({ scheme: "https", host: "api.example.com" }, requestId),
        envelopeFor("api.example.com"),
        auth(requestId),
      );
      expect(result.status, `broker(${ip})`).toBe("succeeded");
    }
  });

  it("metadata endpoints stay blocked even when private addresses are allowed (F5)", async () => {
    for (const ip of ["169.254.169.254", "100.100.100.200"]) {
      const check = await validateEndpointUrl(`http://${ip}/latest/meta-data`, {
        ssrfAllowPrivate: true,
        deps: { resolve: async () => [ip] },
      });
      expect(check.valid, `allowPrivate still blocks metadata: ${ip}`).toBe(false);
      expect(check.error).toMatch(/metadata/i);
    }
    // Embedded spellings of the Alibaba metadata address are blocked too
    for (const spelling of ["::ffff:100.100.100.200", "::6464:64c8"]) {
      const check = await validateEndpointUrl(`http://[${spelling}]/latest/meta-data`, {
        ssrfAllowPrivate: true,
        deps: { resolve: async () => [spelling] },
      });
      expect(check.valid, `allowPrivate still blocks metadata: ${spelling}`).toBe(false);
      expect(check.error).toMatch(/metadata/i);
    }
  });

  it("keeps the transport validator in lockstep with the broker classifier", async () => {
    for (const ip of MUST_DENY) {
      const url = ip.includes(":") ? `http://[${ip}]/x` : `http://${ip}/x`;
      const check = await validateEndpointUrl(url, {
        deps: { resolve: async () => [ip] },
      });
      expect(check.valid, `validateEndpointUrl(${ip})`).toBe(false);
    }
    for (const ip of MUST_ALLOW) {
      // IPv6 literals must be bracketed in URLs
      const url = ip.includes(":") ? `http://[${ip}]/x` : `http://${ip}/x`;
      const check = await validateEndpointUrl(url, {
        deps: { resolve: async () => [ip] },
      });
      expect(check.valid, `validateEndpointUrl(${ip})`).toBe(true);
    }
  });
});

describe("W143 — cross-host redirect strips credentials case-insensitively", () => {
  it("deletes mixed-case Authorization/X-Api-Key/Cookie headers before following a redirect", async () => {
    const seenHeaders: Array<Record<string, string>> = [];
    let calls = 0;
    const network: BrokerNetworkAdapter = {
      async resolve() {
        return ["93.184.216.34"];
      },
      async fetch(destination, init): Promise<BrokerNetworkResponse> {
        calls++;
        seenHeaders.push({ ...(init.headers as Record<string, string>) });
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
      ...envelopeFor("api.example.com"),
      capabilities: [
        { kind: "network-destination", scheme: "https", host: "api.example.com" },
        { kind: "network-destination", scheme: "https", host: "cdn.example.com" },
      ],
    };
    const result = await broker.execute(
      {
        kind: "http",
        requestId: "req-mixed-case",
        destination: { scheme: "https", host: "api.example.com" },
        method: "GET",
        headers: {
          // Mixed-case credential spellings — the old exact-lowercase deletes
          // leaked every one of these to the redirect target.
          "X-Api-Key": "secret-key-value",
          "Authorization": "Bearer token-value",
          "Cookie": "session=abc",
          "API-KEY": "upper-key-value",
          "X-Custom-Trace": "keep-me",
        },
        secretRefs: [],
      },
      env,
      auth("req-mixed-case"),
    );

    expect(result.status).toBe("succeeded");
    expect(calls).toBe(2);

    const redirectHeaders = seenHeaders[1];
    const lowerKeys = Object.keys(redirectHeaders).map((k) => k.toLowerCase());
    expect(lowerKeys).not.toContain("x-api-key");
    expect(lowerKeys).not.toContain("api-key");
    expect(lowerKeys).not.toContain("authorization");
    expect(lowerKeys).not.toContain("cookie");
    // Non-credential headers still forwarded
    expect(redirectHeaders["X-Custom-Trace"]).toBe("keep-me");
  });
});
