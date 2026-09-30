/**
 * US0 red gate (022-5-WO2 T002, pass-12 P1-1): the brokered network adapter
 * must arm pinnedFetch's streaming size cap — today it buffers the entire
 * response body before the broker's 10 MiB cap runs, so a fast attacker
 * endpoint OOMs the shared process (lead-reproduced: 300 MiB in 237 ms).
 * The gate streams past the default cap and requires a typed rejection with
 * bounded buffering, not a resolved 200.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { NodeNetworkAdapter } from "../effect-broker.js";
import type { NetworkDestination } from "../../../foundations/contracts/tool-effects.js";

describe("NodeNetworkAdapter response cap (022-5-WO2 T002)", () => {
  let server: Server;
  let port: number;

  beforeEach(async () => {
    server = createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      // 64 MiB — well past the 10 MiB default cap, streamed fast.
      const chunk = Buffer.alloc(1024 * 1024, 0x41);
      const timer = setInterval(() => {
        res.write(chunk);
      }, 5);
      req.on("close", () => clearInterval(timer));
      // Safety stop.
      setTimeout(() => {
        clearInterval(timer);
        res.end();
      }, 8000);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
  });
  afterEach(async () => {
    server.close();
  });

  it("an under-cap response still succeeds (no false-positive direction)", async () => {
    const small = createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(Buffer.alloc(4 * 1024 * 1024, 0x42)); // 4 MiB < 10 MiB cap
    });
    await new Promise<void>((resolve) => small.listen(0, "127.0.0.1", resolve));
    try {
      const adapter = new NodeNetworkAdapter();
      const port = (small.address() as { port: number }).port;
      const result = await adapter.fetch(
        { scheme: "http", host: "127.0.0.1", port, pathPrefix: "/small" },
        { method: "GET", headers: {} },
        ["127.0.0.1"],
      );
      expect(result.status).toBe(200);
      expect(result.bytes.length).toBe(4 * 1024 * 1024);
    } finally {
      small.close();
    }
  });

  it("rejects when the response streams past the cap instead of buffering it all", async () => {
    const adapter = new NodeNetworkAdapter();
    const destination: NetworkDestination = {
      scheme: "http",
      host: "127.0.0.1",
      port,
      pathPrefix: "/big",
    };
    const started = Date.now();
    let resolved = false;
    let error: unknown;
    try {
      const result = await adapter.fetch(
        destination,
        { method: "GET", headers: {} },
        ["127.0.0.1"],
      );
      resolved = true;
      if (result.bytes.length > 11 * 1024 * 1024) {
        expect.fail(`buffered ${result.bytes.length} bytes — the cap is not armed on the streaming path`);
      }
    } catch (err) {
      error = err;
    }
    const elapsed = Date.now() - started;

    // Either it rejected with the size error (the fix) or it must not have
    // resolved with an over-cap body. A clean resolve under the cap is the
    // only acceptable "resolve" — and 64 MiB streamed cannot be.
    expect(resolved, `adapter resolved (buffered everything); elapsed=${elapsed}ms; error=${String(error)}`).toBe(false);
    expect(String((error as Error)?.message)).toMatch(/maximum limit|size/i);
  });
});
