/**
 * Cross-hop deadline in safeSsrfFetch (021-4 W144).
 *
 * A redirect chain must be bounded by one absolute deadline — not by
 * per-hop timeouts multiplied across hops — and the hop-cap error must
 * interpolate the configured cap.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { safeSsrfFetch } from "../../../foundations/network/ssrf-fetch.js";

describe("W144 — safeSsrfFetch cross-hop deadline", () => {
  let redirectServer: http.Server;
  let port: number;

  beforeAll(async () => {
    // Always redirect to itself — an endless chain under the hop cap.
    // ~120ms per hop: the hop cap needs 6 fast hops, the 250ms overall
    // deadline fires first, while the 2-hop cap test still completes.
    redirectServer = http.createServer((req, res) => {
      setTimeout(() => {
        res.writeHead(302, { location: `http://127.0.0.1:${port}/next` });
        res.end();
      }, 120);
    });
    await new Promise<void>((resolve) => redirectServer.listen(0, "127.0.0.1", () => resolve()));
    port = (redirectServer.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => redirectServer.close(() => resolve()));
  });

  it("aborts with a deadline error when the overall budget expires across hops", async () => {
    await expect(
      safeSsrfFetch(`http://127.0.0.1:${port}/start`, undefined, {
        ssrfAllowPrivate: true,
        timeoutMs: 10_000,
        overallTimeoutMs: 250,
      }),
    ).rejects.toThrow(/deadline/i);
  });

  it("interpolates the configured hop cap in the hop-limit error", async () => {
    await expect(
      safeSsrfFetch(`http://127.0.0.1:${port}/start`, undefined, {
        ssrfAllowPrivate: true,
        maxRedirects: 2,
        overallTimeoutMs: 10_000,
      }),
    ).rejects.toThrow(/hops \(2\)/);
  });
});
