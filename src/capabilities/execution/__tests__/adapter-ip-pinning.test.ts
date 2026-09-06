/**
 * A2 — the default network adapter must pin to the broker-VALIDATED IP list.
 *
 * Re-resolving DNS inside fetch() reopens the validate-then-connect rebinding
 * window: the request (method, headers, body) would be delivered to whatever
 * the fresh lookup returns, even though the post-flight check blocks the
 * reply. The adapter now connects only to the passed addresses.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { NodeNetworkAdapter } from "../effect-broker.js";

describe("A2 — NodeNetworkAdapter pins to validated IPs", () => {
  let server: http.Server;
  let port: number;
  let hits = 0;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      hits++;
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("does not re-resolve DNS when validated IPs are provided", async () => {
    const adapter = new NodeNetworkAdapter();
    const resolveSpy = vi.spyOn(adapter, "resolve");

    const res = await adapter.fetch(
      { scheme: "http", host: "web.example.com", port, pathPrefix: "/" },
      { method: "GET", headers: {} },
      ["127.0.0.1"],
    );

    expect(resolveSpy).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(res.effectiveIp).toBe("127.0.0.1");
    expect(hits).toBe(1);
  });

  it("falls back to resolving when called without validated IPs", async () => {
    const adapter = new NodeNetworkAdapter();
    // The test host "127.0.0.1" resolves directly via dns.lookup
    const res = await adapter.fetch(
      { scheme: "http", host: "127.0.0.1", port, pathPrefix: "/" },
      { method: "GET", headers: {} },
    );
    expect(res.status).toBe(200);
    expect(res.effectiveIp).toBe("127.0.0.1");
  });
});
