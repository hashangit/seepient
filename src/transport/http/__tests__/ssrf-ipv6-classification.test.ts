import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { validateEndpointUrl,  } from "../../../foundations/network/ssrf-fetch.js";
import { isPrivateIp, isMetadataIp } from "../../../foundations/network/ip-classifier.js";

describe("W012: IPv6 classification by bytes & URL bracket stripping", () => {
  it("classifies verified-broken IPv6 representations as private", () => {
    // Verified-broken in review:
    expect(isPrivateIp("::7f00:1")).toBe(true);
    expect(isPrivateIp("::ffff:0:7f00:1")).toBe(true);
  });

  it("detects IPv6 metadata addresses including fd00:ec2::254 and mapped forms", () => {
    // AWS/cloud IPv6 metadata address
    expect(isMetadataIp("fd00:ec2::254")).toBe(true);
    expect(isMetadataIp("FD00:EC2::254")).toBe(true);
    expect(isMetadataIp("fd00:0ec2:0000:0000:0000:0000:0000:0254")).toBe(true);

    // IPv4-compatible and SIIT hex metadata
    expect(isMetadataIp("::a9fe:a9fe")).toBe(true);
    expect(isMetadataIp("::ffff:0:a9fe:a9fe")).toBe(true);
    expect(isMetadataIp("::ffff:a9fe:a9fe")).toBe(true);

    // NAT64 WKP metadata (W036)
    expect(isMetadataIp("64:ff9b::a9fe:a9fe")).toBe(true);
    expect(isMetadataIp("64:ff9b::169.254.169.254")).toBe(true);
  });

  it("permits public IPv6 unicast addresses", () => {
    expect(isPrivateIp("2606:4700:4700::1111")).toBe(false);
    expect(isMetadataIp("2606:4700:4700::1111")).toBe(false);
    expect(isPrivateIp("2001:4860:4860::8888")).toBe(false);
  });

  it("blocks every spelling of blocked IPv4 addresses (property test)", () => {
    const blockedIpv4s = [
      { dotted: "127.0.0.1", hex: "7f00:1" },
      { dotted: "10.0.0.1", hex: "a00:1" },
      { dotted: "192.168.1.1", hex: "c0a8:101" },
      { dotted: "169.254.169.254", hex: "a9fe:a9fe" },
      { dotted: "172.16.0.1", hex: "ac10:1" },
    ];

    for (const { dotted, hex } of blockedIpv4s) {
      // Dotted IPv4
      expect(isPrivateIp(dotted)).toBe(true);

      // IPv4-mapped dotted and hex
      expect(isPrivateIp(`::ffff:${dotted}`)).toBe(true);
      expect(isPrivateIp(`::ffff:${hex}`)).toBe(true);

      // SIIT dotted and hex
      expect(isPrivateIp(`::ffff:0:${dotted}`)).toBe(true);
      expect(isPrivateIp(`::ffff:0:${hex}`)).toBe(true);

      // IPv4-compatible dotted and hex
      expect(isPrivateIp(`::${dotted}`)).toBe(true);
      expect(isPrivateIp(`::${hex}`)).toBe(true);

      // NAT64 dotted and hex
      expect(isPrivateIp(`64:ff9b::${dotted}`)).toBe(true);
      expect(isPrivateIp(`64:ff9b::${hex}`)).toBe(true);
    }
  });

  it("strips URL hostname brackets so http://[::1]:11434 validates without ENOTFOUND", async () => {
    const res = await validateEndpointUrl("http://[::1]:11434", { ssrfAllowPrivate: true });
    expect(res.valid).toBe(true);
    expect(res.resolvedIps).toEqual(["::1"]);
  });

  it("blocks http://[::1]:11434 when ssrfAllowPrivate is false", async () => {
    const res = await validateEndpointUrl("http://[::1]:11434", { ssrfAllowPrivate: false });
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/Access to private\/local address/);
  });

  it("permanently blocks http://[fd00:ec2::254]/ even when ssrfAllowPrivate is true", async () => {
    const res = await validateEndpointUrl("http://[fd00:ec2::254]/latest/meta-data", {
      ssrfAllowPrivate: true,
    });
    expect(res.valid).toBe(false);
    expect(res.error).toContain("cloud metadata");
  });

  it("permanently blocks NAT64 metadata http://[64:ff9b::a9fe:a9fe]/ even when ssrfAllowPrivate is true (W036)", async () => {
    const res = await validateEndpointUrl("http://[64:ff9b::a9fe:a9fe]/latest/meta-data", {
      ssrfAllowPrivate: true,
    });
    expect(res.valid).toBe(false);
    expect(res.error).toContain("cloud metadata");
  });
});

import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { pinnedFetch } from "../../../foundations/network/pinned-fetch.js";

describe("W012: Loopback-pinned public IPv6 literal connection", () => {
  let server: http.Server;
  let port: number;
  let serverHits = 0;
  let receivedHost = "";

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      serverHits++;
      receivedHost = req.headers["host"] ?? "";
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("v6 ok");
    });
    // Listen on IPv4 loopback
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("connects to loopback while pinning a public IPv6 literal URL with bracket Host header", async () => {
    serverHits = 0;
    receivedHost = "";

    // pinnedFetch connects to 127.0.0.1 while preserving the public IPv6 URL and Host header
    const res = await pinnedFetch({
      url: `http://[2606:4700:4700::1111]:${port}/test`,
      ips: ["127.0.0.1"],
    });

    expect(res.status).toBe(200);
    expect(serverHits).toBe(1);
    expect(receivedHost).toBe("[2606:4700:4700::1111]");
  });
});
