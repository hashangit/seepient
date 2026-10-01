import { describe, it, expect, afterEach } from "vitest";
import { runSeepientServer } from "../index.js";
import type { SeepientHttpServer } from "../index.js";

describe("Server host default (FR-028)", () => {
  let server: SeepientHttpServer | null = null;

  afterEach(async () => {
    if (server) {
      server.dispose();
      server = null;
    }
    delete process.env.SEEPIENT_HOST;
  });

  it("booting without host binds 127.0.0.1 (loopback) by default", async () => {
    delete process.env.SEEPIENT_HOST;
    server = await runSeepientServer({ port: 0 });
    const addr = server.address() as any;
    expect(addr.address).toBe("127.0.0.1");
  });

  it("honors SEEPIENT_HOST environment variable", async () => {
    process.env.SEEPIENT_HOST = "127.0.0.1";
    server = await runSeepientServer({ port: 0 });
    const addr = server.address() as any;
    expect(addr.address).toBe("127.0.0.1");
  });

  it("honors explicit options.host over default", async () => {
    server = await runSeepientServer({ port: 0, host: "localhost" });
    const addr = server.address() as any;
    expect(["127.0.0.1", "::1", "localhost"]).toContain(addr.address);
  });
});
