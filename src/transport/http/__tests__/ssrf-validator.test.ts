import { describe, it, expect } from "vitest";
import {
  isPrivateIp,
  isMetadataIp,
  normalizeIp,
  validateEndpointUrl,
} from "../ssrf-validator.js";

describe("SSRF Validator Security Verification", () => {
  it("normalizes IPv4-mapped IPv6 formats correctly", () => {
    expect(normalizeIp("::ffff:10.0.0.1")).toBe("10.0.0.1");
    expect(normalizeIp("::ffff:169.254.169.254")).toBe("169.254.169.254");
    expect(normalizeIp("::ffff:a9fe:a9fe")).toBe("169.254.169.254");
  });

  it("detects private IP addresses", () => {
    expect(isPrivateIp("127.0.0.1")).toBe(true);
    expect(isPrivateIp("0.0.0.0")).toBe(true);
    expect(isPrivateIp("0.1.2.3")).toBe(true);
    expect(isPrivateIp("::")).toBe(true);
    expect(isPrivateIp("::ffff:0:0")).toBe(true);
    expect(isPrivateIp("10.1.2.3")).toBe(true);
    expect(isPrivateIp("192.168.1.1")).toBe(true);
    expect(isPrivateIp("172.20.0.1")).toBe(true);
    expect(isPrivateIp("::1")).toBe(true);
    expect(isPrivateIp("::ffff:10.0.0.1")).toBe(true);
    expect(isPrivateIp("8.8.8.8")).toBe(false);
  });

  it("detects metadata IP addresses including mapped forms", () => {
    expect(isMetadataIp("169.254.169.254")).toBe(true);
    expect(isMetadataIp("::ffff:169.254.169.254")).toBe(true);
    expect(isMetadataIp("::ffff:a9fe:a9fe")).toBe(true);
    expect(isMetadataIp("1.1.1.1")).toBe(false);
  });

  it("blocks cloud metadata URLs permanently", async () => {
    const res1 = await validateEndpointUrl("http://169.254.169.254/latest/meta-data");
    expect(res1.valid).toBe(false);
    expect(res1.error).toContain("cloud metadata");

    const res2 = await validateEndpointUrl("http://metadata.google.internal/computeMetadata/v1");
    expect(res2.valid).toBe(false);
  });

  it("blocks private IPs unless ssrfAllowPrivate is set", async () => {
    const res1 = await validateEndpointUrl("http://127.0.0.1:8080");
    expect(res1.valid).toBe(false);

    const res2 = await validateEndpointUrl("http://127.0.0.1:8080", { ssrfAllowPrivate: true });
    expect(res2.valid).toBe(true);
  });

  it("fails closed on non-existent DNS hostnames", async () => {
    const res = await validateEndpointUrl("https://non-existent-domain-for-testing-123456789.org");
    expect(res.valid).toBe(false);
    expect(res.error).toContain("DNS resolution failed");
  });
});
