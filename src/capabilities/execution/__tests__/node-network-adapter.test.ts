/**
 * NodeNetworkAdapter real-socket regression tests (Spec 017 hotfix).
 *
 * The adapter pins DNS via a custom `lookup` option on http/https requests.
 * Node >= 20 with autoSelectFamily (happy-eyeballs, default on) invokes the
 * lookup with `{ all: true }` and expects an `[{address, family}]` array;
 * answering that with the legacy single-address form makes net throw
 * ERR_INVALID_IP_ADDRESS ("Invalid IP address: undefined") — the crash that
 * broke web_search/read_website end-to-end. These tests drive the adapter
 * through a real net socket (DNS mocked to a loopback server) so both
 * callback forms stay covered.
 */
import { describe, expect, it, vi, afterAll, beforeAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "127.0.0.1", family: 4 }]),
}));

import { NodeNetworkAdapter } from "../effect-broker.js";

describe("NodeNetworkAdapter real-socket fetch", () => {
  let server: http.Server;
  let port: number;
  const seenRequests: Array<{ host: string | undefined; url: string | undefined }> = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      seenRequests.push({ host: req.headers.host, url: req.url });
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("adapter-ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("completes an HTTP request through the pinned-IP lookup without ERR_INVALID_IP_ADDRESS", async () => {
    const adapter = new NodeNetworkAdapter();
    const response = await adapter.fetch(
      { scheme: "http", host: "pinned.test", port, pathPrefix: "/probe" },
      { method: "GET", headers: {} },
    );

    expect(response.status).toBe(200);
    expect(new TextDecoder().decode(response.bytes)).toBe("adapter-ok");
    // The connection must go to the pre-resolved (pinned) IP, not real DNS.
    expect(response.effectiveIp).toBe("127.0.0.1");
    expect(response.effectiveHost).toBe("pinned.test");
    // Host header/SNI keep the logical hostname, not the pinned IP.
    expect(seenRequests.at(-1)?.host).toBe("pinned.test");
    expect(seenRequests.at(-1)?.url).toBe("/probe");
  });

  it("sends method, path, and headers through the real socket", async () => {
    const adapter = new NodeNetworkAdapter();
    const response = await adapter.fetch(
      { scheme: "http", host: "pinned.test", port, pathPrefix: "/echo" },
      { method: "POST", headers: { "content-type": "application/json" }, body: new TextEncoder().encode("{}") },
    );

    expect(response.status).toBe(200);
    expect(new TextDecoder().decode(response.bytes)).toBe("adapter-ok");
    expect(seenRequests.at(-1)?.url).toBe("/echo");
  });
});
