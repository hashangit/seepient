import { describe, it, expect } from "vitest";
import {
  isPrivateIp,
  isMetadataIp,
  validateEndpointUrl,
  normalizeIp,
} from "../ssrf-validator.js";

describe("WS8: SSRF Hardening & Security (B-21)", () => {
  it("allows public IPv4 addresses that contain '169.254' as a substring", () => {
    expect(isMetadataIp("8.169.254.1")).toBe(false);
    expect(isPrivateIp("8.169.254.1")).toBe(false);
  });

  it("blocks cloud metadata IPs across normalized formats", () => {
    expect(isMetadataIp("169.254.169.254")).toBe(true);
    expect(isMetadataIp("::ffff:169.254.169.254")).toBe(true);
    expect(isMetadataIp("::ffff:a9fe:a9fe")).toBe(true);
  });

  it("blocks IPv6 link-local addresses across the full fe80::/10 range", () => {
    expect(isPrivateIp("fe80::1")).toBe(true);
    expect(isPrivateIp("fe90::1")).toBe(true);
    expect(isPrivateIp("fea0::1")).toBe(true);
    expect(isPrivateIp("feb0::1")).toBe(true);
  });

  it("returns resolvedIps on valid URL validation", async () => {
    const res = await validateEndpointUrl("https://1.1.1.1/v1", { ssrfAllowPrivate: false });
    expect(res.valid).toBe(true);
    expect(res.resolvedIps).toContain("1.1.1.1");
  });

  it("blocks loopback and private IPs when ssrfAllowPrivate is false", async () => {
    const res = await validateEndpointUrl("http://127.0.0.1:11434/v1", { ssrfAllowPrivate: false });
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/Access to private\/local address/);
  });

  it("permits loopback and private IPs when ssrfAllowPrivate is true (e.g. Ollama)", async () => {
    const res = await validateEndpointUrl("http://127.0.0.1:11434/v1", { ssrfAllowPrivate: true });
    expect(res.valid).toBe(true);
  });
});
