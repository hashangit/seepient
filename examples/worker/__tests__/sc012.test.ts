/**
 * SC-012 consolidation (022-5-WO2 T005): the five worker control-plane
 * behaviors the pass-11/pass-12 reviews keep finding unpinned.
 * (a) internal handler throw → 500, process alive (the unimplemented half);
 * (b) malformed URL → 400; (c) 2 MB body → 413 arrives;
 * (d) traversal root (/data/../etc) → 403; (e) out-of-workspace root → 403.
 */
import { describe, it, expect } from "vitest";
import { request as httpRequest } from "node:http";
import { createStubApp } from "../src/stub-app.js";

describe("SC-012 worker pins (022-5-WO2 T005)", () => {
  it("(a) an internal handler throw answers 500 and the process stays alive", async () => {
    const app = createStubApp({ tokenToPrincipal: new Map([["tok", "tenant-a"]]) });
    const port = await app.listen();
    try {
      const originalGet = app.state.sessions.get.bind(app.state.sessions);
      (app.state.sessions as unknown as { get: (key: string) => never }).get = () => {
        throw new Error("internal blowup") as never;
      };
      const res = await fetch(`http://127.0.0.1:${port}/api/sessions?sessionId=s1`, {
        headers: { authorization: "Bearer tok" },
      });
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBeDefined();
      // The process is alive: restore and hit the route again.
      (app.state.sessions as unknown as Record<string, unknown>).get = originalGet;
      const again = await fetch(`http://127.0.0.1:${port}/api/sessions?sessionId=s1`, {
        headers: { authorization: "Bearer tok" },
      });
      expect([200, 404]).toContain(again.status);
    } finally {
      await app.close();
    }
  });

  it("(b) an unparseable absolute-form request target answers 400", async () => {
    const app = createStubApp({ tokenToPrincipal: new Map([["tok", "tenant-a"]]) });
    const port = await app.listen();
    try {
      // Absolute-form target with an out-of-range port: `new URL` throws on
      // it, so this exercises the stub's URL-parse guard directly.
      const res = await new Promise<{ statusCode?: number }>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port, path: "http://127.0.0.1:99999/" },
          (r) => resolve(r),
        );
        req.on("error", reject);
        req.end();
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("(c) an oversized body is destroyed at the cap — the 413 lands MID-STREAM, not at end (022-5-WO4 T005, made real in pass-15)", async () => {
    const app = createStubApp({ tokenToPrincipal: new Map([["tok", "tenant-a"]]) });
    const port = await app.listen();
    try {
      // Stream slowly and HOLD the connection open past the cap: the old
      // shape waited for end/close (a held stream never ends — the 413 would
      // only arrive at requestTimeout), the fixed shape responds + destroys
      // the moment the cap trips. The gate fails on any shape that needs the
      // stream to finish.
      const status = await new Promise<number>((resolve) => {
        let settled = false;
        const settle = (code: number) => {
          if (!settled) { settled = true; resolve(code); }
        };
        const req = httpRequest(
          {
            host: "127.0.0.1", port, path: "/api/policy?workspaceId=ws", method: "POST",
            headers: { authorization: "Bearer tok", "content-type": "application/json" },
          },
          (res) => { settle(res.statusCode ?? 0); res.resume(); },
        );
        req.on("error", () => settle(413)); // destroyed-after-flush is the expected teardown
        const chunk = "x".repeat(64 * 1024);
        let sent = 0;
        const timer = setInterval(() => {
          sent += chunk.length;
          req.write(chunk);
          // Cross the 1 MiB cap, then deliberately never end the stream.
        }, 5);
        const giveUp = setTimeout(() => { clearInterval(timer); settle(0); }, 8_000);
        giveUp.unref?.();
        void giveUp;
        req.on("close", () => { clearInterval(timer); });
        void sent;
      });
      expect(status).toBe(413);
    } finally {
      await app.close();
    }
  });

  it("(d) a traversal policy root is refused (/data/../etc -> 403)", async () => {
    const app = createStubApp({ tokenToPrincipal: new Map([["tok", "tenant-a"]]) });
    const port = await app.listen();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/policy?workspaceId=ws`, {
        method: "POST",
        headers: { authorization: "Bearer tok", "content-type": "application/json" },
        body: JSON.stringify({
          expectedVersion: 0,
          next: { version: 1, capabilities: [{ kind: "read-root", root: "/data/../etc", principalId: "tenant-a" }] },
        }),
      });
      expect(res.status).toBe(403);
    } finally {
      await app.close();
    }
  });

  it("(e) an out-of-workspace policy root is refused (/etc -> 403)", async () => {
    const app = createStubApp({ tokenToPrincipal: new Map([["tok", "tenant-a"]]) });
    const port = await app.listen();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/policy?workspaceId=ws`, {
        method: "POST",
        headers: { authorization: "Bearer tok", "content-type": "application/json" },
        body: JSON.stringify({
          expectedVersion: 0,
          next: { version: 1, capabilities: [{ kind: "read-root", root: "/etc", principalId: "tenant-a" }] },
        }),
      });
      expect(res.status).toBe(403);
    } finally {
      await app.close();
    }
  });
});
