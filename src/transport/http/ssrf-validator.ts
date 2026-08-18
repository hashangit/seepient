/**
 * SSRF Protection Validator for Custom / Upstream Provider Endpoints
 *
 * Implements the security contract defined in `contracts/server-management-api.md`.
 * Enforces fail-closed DNS resolution, IPv4/IPv6 CIDR ranges, and IPv4-mapped IPv6 decoding.
 */

import * as dns from "dns/promises";
import * as net from "net";

const METADATA_IP_PREFIX = "169.254.";

/**
 * Normalizes an IPv4 or IPv6 address, unmapping IPv4-mapped IPv6 formats
 * (e.g. ::ffff:10.0.0.1 or ::ffff:a9fe:a9fe -> 169.254.169.254).
 */
export function normalizeIp(ip: string): string {
  let lower = ip.toLowerCase();
  if (lower.startsWith("::ffff:")) {
    const remainder = lower.slice(7);
    if (remainder.includes(".")) {
      return remainder;
    }
    const parts = remainder.split(":");
    if (parts.length === 2) {
      const h1 = parseInt(parts[0], 16);
      const h2 = parseInt(parts[1], 16);
      if (!isNaN(h1) && !isNaN(h2)) {
        const oct1 = (h1 >> 8) & 0xff;
        const oct2 = h1 & 0xff;
        const oct3 = (h2 >> 8) & 0xff;
        const oct4 = h2 & 0xff;
        return `${oct1}.${oct2}.${oct3}.${oct4}`;
      }
    }
  }
  return lower;
}

export function isPrivateIp(ip: string): boolean {
  const norm = normalizeIp(ip);
  if (
    norm === "0.0.0.0" ||
    norm.startsWith("0.") ||
    norm === "::" ||
    norm === "::ffff:0:0" ||
    norm === "::ffff:0.0.0.0" ||
    /^0(:0)+$/.test(norm) ||
    norm === "::1" ||
    norm === "127.0.0.1" ||
    norm.startsWith("127.")
  ) {
    return true;
  }
  if (norm.startsWith("10.") || norm.startsWith("192.168.")) {
    return true;
  }
  if (norm.startsWith("172.")) {
    const parts = norm.split(".");
    const second = parseInt(parts[1], 10);
    if (second >= 16 && second <= 31) return true;
  }
  // Carrier-grade NAT (100.64.0.0/10)
  if (norm.startsWith("100.")) {
    const parts = norm.split(".");
    const second = parseInt(parts[1], 10);
    if (second >= 64 && second <= 127) return true;
  }
  // IPv6 ULA (fc00::/7) and link-local (fe80::/10 covers fe80..febf)
  if (norm.startsWith("fc") || norm.startsWith("fd") || /^fe[89ab]/i.test(norm)) {
    return true;
  }
  return false;
}

export function isMetadataIp(ip: string): boolean {
  const norm = normalizeIp(ip);
  if (norm.startsWith(METADATA_IP_PREFIX)) return true;
  return false;
}

export async function validateEndpointUrl(
  rawUrl: string,
  options: { ssrfAllowPrivate?: boolean } = {},
): Promise<{ valid: boolean; resolvedIps?: string[]; error?: string }> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { valid: false, error: "Invalid URL format" };
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { valid: false, error: `Unsupported protocol "${parsed.protocol}" (only https and http permitted)` };
  }

  const hostname = parsed.hostname.toLowerCase();

  // Explicit check for cloud metadata hostnames
  if (
    hostname === "169.254.169.254" ||
    hostname === "metadata.google.internal" ||
    hostname.endsWith(".metadata.google.internal")
  ) {
    return { valid: false, error: "Access to cloud metadata endpoints is permanently forbidden" };
  }

  // Resolve hostname to IP addresses (fail-closed on failure)
  let ips: string[] = [];
  if (net.isIP(hostname)) {
    ips = [hostname];
  } else if (hostname === "localhost") {
    ips = ["127.0.0.1"];
  } else {
    try {
      const records = await dns.lookup(hostname, { all: true });
      ips = records.map((r) => r.address);
      if (ips.length === 0) {
        return { valid: false, error: `DNS lookup returned no IP addresses for hostname "${hostname}"` };
      }
    } catch (err: any) {
      return { valid: false, error: `DNS resolution failed for hostname "${hostname}": ${err.message}` };
    }
  }

  for (const rawIp of ips) {
    const ip = normalizeIp(rawIp);
    if (isMetadataIp(ip)) {
      return { valid: false, error: "Access to cloud metadata endpoints is permanently forbidden" };
    }
    if (isPrivateIp(ip) && !options.ssrfAllowPrivate) {
      return {
        valid: false,
        error: `Access to private/local address "${ip}" is blocked (requires ssrfAllowPrivate: true)`,
      };
    }
  }

  return { valid: true, resolvedIps: ips };
}
