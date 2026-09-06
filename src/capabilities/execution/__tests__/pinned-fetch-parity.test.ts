import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { pinnedFetch } from "../../../foundations/network/pinned-fetch.js";

describe("W017: pinnedFetch parity with effect-broker source", () => {
  let server: http.Server;
  let serverPort: number;
  let lastHostHeader: string | undefined;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      lastHostHeader = req.headers.host;
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${serverPort}`);

      if (url.pathname === "/slow") {
        // Delay response to test timeout
        setTimeout(() => {
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end("slow-done");
        }, 300);
        return;
      }

      if (url.pathname === "/large") {
        // Send a large stream
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.write("x".repeat(1000));
        res.end();
        return;
      }

      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    serverPort = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("enforces URL hostname precedence for Host header over caller-provided header", async () => {
    lastHostHeader = undefined;
    const res = await pinnedFetch({
      url: `http://genuine-domain.com:${serverPort}/test`,
      ips: ["127.0.0.1"],
      headers: {
        Host: "malicious-vhost-pivot.com",
        "X-Other": "preserved",
      },
    });

    expect(res.status).toBe(200);
    expect(lastHostHeader).toBe("genuine-domain.com");
  });

  it("times out when response exceeds timeoutMs option", async () => {
    await expect(
      pinnedFetch({
        url: `http://127.0.0.1:${serverPort}/slow`,
        ips: ["127.0.0.1"],
        timeoutMs: 50,
      }),
    ).rejects.toThrow(/timed out/i);
  });

  it("rejects when response body exceeds maxResponseBytes option", async () => {
    await expect(
      pinnedFetch({
        url: `http://127.0.0.1:${serverPort}/large`,
        ips: ["127.0.0.1"],
        maxResponseBytes: 100,
      }),
    ).rejects.toThrow(/exceeded maximum limit/i);
  });

  it("rejects when effectiveIp does not belong to validated ips (post-flight DNS rebinding re-check)", async () => {
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
        url: `http://127.0.0.1:${serverPort}/test`,
        ips: ["127.0.0.1"],
        agent,
      }),
    ).rejects.toThrow(/DNS rebinding detected: connection made to 198.51.100.99 not in validated IPs/i);
  });
});
