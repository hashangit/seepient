import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { safeSsrfFetch } from "../../../foundations/network/ssrf-fetch.js";

describe("W016: Redirect hygiene in safeSsrfFetch", () => {
  let originServer: http.Server;
  let originPort: number;
  let targetServer: http.Server;
  let targetPort: number;

  interface TargetRequestInfo {
    method: string;
    headers: http.IncomingHttpHeaders;
    body: string;
  }

  let lastTargetRequest: TargetRequestInfo | null = null;

  beforeAll(async () => {
    // Target server: records received request details
    targetServer = http.createServer((req, res) => {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => {
        lastTargetRequest = {
          method: req.method ?? "GET",
          headers: req.headers,
          body: data,
        };
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ok");
      });
    });
    await new Promise<void>((resolve) => targetServer.listen(0, "127.0.0.1", () => resolve()));
    targetPort = (targetServer.address() as AddressInfo).port;

    // Origin server: issues redirects
    originServer = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${originPort}`);
      const type = url.searchParams.get("type");
      const cross = url.searchParams.get("cross") === "1";

      const destination = cross
        ? `http://127.0.0.1:${targetPort}/target`
        : `/same-origin-target`;

      if (url.pathname === "/same-origin-target") {
        let data = "";
        req.on("data", (chunk) => (data += chunk));
        req.on("end", () => {
          lastTargetRequest = {
            method: req.method ?? "GET",
            headers: req.headers,
            body: data,
          };
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end("same-origin-ok");
        });
        return;
      }

      const status = parseInt(type ?? "302", 10);
      res.writeHead(status, { Location: destination });
      res.end();
    });
    await new Promise<void>((resolve) => originServer.listen(0, "127.0.0.1", () => resolve()));
    originPort = (originServer.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => originServer.close(() => resolve()));
    await new Promise<void>((resolve) => targetServer.close(() => resolve()));
  });

  it("strips Authorization, Cookie, api-key, and x-api-key on cross-origin redirects", async () => {
    lastTargetRequest = null;
    await safeSsrfFetch(
      `http://127.0.0.1:${originPort}/redirect?type=302&cross=1`,
      {
        headers: {
          Authorization: "Bearer secret-token",
          Cookie: "session=xyz",
          "api-key": "secret-key",
          "x-api-key": "secret-x-key",
          "X-Custom-Header": "keep-me",
        },
      },
      { ssrfAllowPrivate: true },
    );

    expect(lastTargetRequest).not.toBeNull();
    const req1 = lastTargetRequest as unknown as TargetRequestInfo;
    expect(req1.headers["authorization"]).toBeUndefined();
    expect(req1.headers["cookie"]).toBeUndefined();
    expect(req1.headers["api-key"]).toBeUndefined();
    expect(req1.headers["x-api-key"]).toBeUndefined();
    expect(req1.headers["x-custom-header"]).toBe("keep-me");
  });

  it("downgrades 301, 302, 303 POST to GET and strips body", async () => {
    for (const status of [301, 302, 303]) {
      lastTargetRequest = null;
      await safeSsrfFetch(
        `http://127.0.0.1:${originPort}/redirect?type=${status}&cross=1`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ message: "do-not-forward-on-downgrade" }),
        },
        { ssrfAllowPrivate: true },
      );

      expect(lastTargetRequest).not.toBeNull();
      const req2 = lastTargetRequest as unknown as TargetRequestInfo;
      expect(req2.method).toBe("GET");
      expect(req2.body).toBe("");
      expect(req2.headers["content-length"]).toBeUndefined();
    }
  });

  it("preserves method and body on 307 and 308 redirects", async () => {
    for (const status of [307, 308]) {
      lastTargetRequest = null;
      const testPayload = JSON.stringify({ message: `payload-for-${status}` });
      await safeSsrfFetch(
        `http://127.0.0.1:${originPort}/redirect?type=${status}&cross=1`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: testPayload,
        },
        { ssrfAllowPrivate: true },
      );

      expect(lastTargetRequest).not.toBeNull();
      const req3 = lastTargetRequest as unknown as TargetRequestInfo;
      expect(req3.method).toBe("POST");
      expect(req3.body).toBe(testPayload);
    }
  });
});
