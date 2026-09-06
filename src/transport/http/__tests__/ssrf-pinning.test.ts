import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { validateEndpointUrl, safeSsrfFetch,  } from "../../../foundations/network/ssrf-fetch.js";
import { isPrivateIp } from "../../../foundations/network/ip-classifier.js";
import { pinnedFetch } from "../../../foundations/network/pinned-fetch.js";

describe("SSRF Pinning & Hardening (Spec 021-2 / T019, QS-6)", () => {
  let targetServer: http.Server;
  let targetPort: number;
  let targetHits = 0;

  let redirectServer: http.Server;
  let redirectPort: number;

  beforeAll(async () => {
    // Target server to simulate loopback service
    targetServer = http.createServer((_req, res) => {
      targetHits++;
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("target reached");
    });
    await new Promise<void>((resolve) => targetServer.listen(0, "127.0.0.1", () => resolve()));
    targetPort = (targetServer.address() as AddressInfo).port;

    // Redirect server to test redirect hop limits: 6 hops
    redirectServer = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${redirectPort}`);
      const hop = parseInt(url.searchParams.get("hop") ?? "1", 10);
      if (hop < 7) {
        res.writeHead(302, { Location: `/redirect?hop=${hop + 1}` });
        res.end();
      } else {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(`hop ${hop} reached`);
      }
    });
    await new Promise<void>((resolve) => redirectServer.listen(0, "127.0.0.1", () => resolve()));
    redirectPort = (redirectServer.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => targetServer.close(() => resolve()));
    await new Promise<void>((resolve) => redirectServer.close(() => resolve()));
  });

  describe("1. Extended IP Ranges Refused", () => {
    it("refuses 192.0.0.0/24 range (RFC 6890)", () => {
      expect(isPrivateIp("192.0.0.1")).toBe(true);
      expect(isPrivateIp("192.0.0.254")).toBe(true);
    });

    it("refuses 198.18.0.0/15 range (RFC 2544 benchmark)", () => {
      expect(isPrivateIp("198.18.0.1")).toBe(true);
      expect(isPrivateIp("198.19.255.254")).toBe(true);
    });

    it("refuses multicast and reserved ranges (224.0.0.0/4 - 255.255.255.255)", () => {
      expect(isPrivateIp("224.0.0.1")).toBe(true);
      expect(isPrivateIp("239.0.0.1")).toBe(true);
      expect(isPrivateIp("240.0.0.1")).toBe(true);
      expect(isPrivateIp("255.255.255.255")).toBe(true);
    });

    it("refuses non-::ffff: IPv4-in-IPv6 forms", () => {
      // SIIT / IPv4-translated / IPv4-compatible
      expect(isPrivateIp("::ffff:0:192.168.1.1")).toBe(true);
      expect(isPrivateIp("::127.0.0.1")).toBe(true);
      expect(isPrivateIp("::10.0.0.1")).toBe(true);
    });
  });

  describe("2. Redirect Limits", () => {
    it("rejects redirect chains exceeding 5 hops", async () => {
      await expect(
        safeSsrfFetch(
          `http://127.0.0.1:${redirectPort}/redirect?hop=1`,
          {},
          { ssrfAllowPrivate: true },
        ),
      ).rejects.toThrow(/redirect/i);
    });
  });

  describe("3. DNS Rebinding Protection via Injected Resolver & Pinning", () => {
    it("pins the socket to validated IP and prevents connecting to rebind address", async () => {
      targetHits = 0;
      let resolveCalls = 0;
      // Injected resolver simulates DNS rebinding:
      // Validation lookup returns a public address, but if connection re-resolved,
      // attacker would return 127.0.0.1:targetPort.
      const injectedResolve = vi.fn().mockImplementation(async () => {
        resolveCalls++;
        if (resolveCalls === 1) {
          return ["93.184.216.34"];
        }
        return ["127.0.0.1"];
      });

      let caughtErr: any = null;
      try {
        await safeSsrfFetch(
          `http://rebind-test.example:${targetPort}/secret`,
          { signal: AbortSignal.timeout(300) },
          { deps: { resolve: injectedResolve } },
        );
      } catch (err: any) {
        caughtErr = err;
      }

      // Loopback server was never contacted because connection was pinned to 93.184.216.34
      expect(targetHits).toBe(0);
      expect(injectedResolve).toHaveBeenCalledWith("rebind-test.example");
      expect(resolveCalls).toBe(1);
      if (caughtErr?.address) {
        expect(caughtErr.address).toBe("93.184.216.34");
      }
    });

    it("ssrfAllowPrivate still pins connection to pre-resolved IP", async () => {
      let resolveCalls = 0;
      const injectedResolve = vi.fn().mockImplementation(async () => {
        resolveCalls++;
        if (resolveCalls === 1) {
          return ["127.0.0.1"];
        }
        return ["10.0.0.1"];
      });
      targetHits = 0;

      const res = await safeSsrfFetch(
        `http://rebind-private.example:${targetPort}/test`,
        {},
        {
          ssrfAllowPrivate: true,
          deps: { resolve: injectedResolve },
        },
      );

      expect(res.status).toBe(200);
      expect(targetHits).toBe(1);
      expect((res as any).effectiveIp).toBe("127.0.0.1");
      expect(resolveCalls).toBe(1);
    });

    it("post-flight rebinding check rejects if socket IP does not match validated IPs", async () => {
      const agent = new http.Agent();
      const origCreateConnection = agent.createConnection;
      agent.createConnection = function (options: any, cb: any) {
        const sock = origCreateConnection.call(this, options, cb);
        Object.defineProperty(sock, "remoteAddress", {
          value: "198.51.100.99",
          configurable: true,
        });
        return sock;
      };

      await expect(
        pinnedFetch({
          url: `http://127.0.0.1:${targetPort}/test`,
          ips: ["127.0.0.1"],
          agent,
        }),
      ).rejects.toThrow(/DNS rebinding detected: connection made to 198.51.100.99 not in validated IPs/i);
    });
  });
});
