/**
 * SSRF Protection Validator for Custom / Upstream Provider Endpoints
 *
 * Implements the security contract defined in `contracts/server-management-api.md`
 * and `contracts/transport-hardening.md` (Spec 021-2 / FR-015, D11).
 * Enforces fail-closed DNS resolution, IPv4/IPv6 CIDR ranges, and IPv4-mapped IPv6 decoding.
 * Policy lives here; mechanism lives in `domain/network/pinned-fetch.ts`.
 */

import * as dns from "node:dns/promises";
import * as net from "node:net";
import { pinnedFetch } from "../../domain/network/pinned-fetch.js";

const METADATA_IP_PREFIX = "169.254.";

/**
 * Normalizes an IPv4 or IPv6 address, unmapping IPv4-mapped IPv6 formats
 * (e.g. ::ffff:10.0.0.1 or ::ffff:a9fe:a9fe -> 169.254.169.254) as well as
 * SIIT (::ffff:0:a.b.c.d) and IPv4-compatible (::a.b.c.d).
 */
export function normalizeIp(ip: string): string {
  let lower = ip.toLowerCase();
  if (lower.startsWith("::ffff:0:") && lower.slice(9).includes(".")) {
    return lower.slice(9);
  }
  if (lower.startsWith("::") && !lower.startsWith("::ffff:") && lower.slice(2).includes(".")) {
    return lower.slice(2);
  }
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
  // 192.0.0.0/24 (RFC 6890 / IANA Special-Purpose)
  if (norm.startsWith("192.0.0.")) {
    return true;
  }
  // 198.18.0.0/15 (RFC 2544 benchmark testing: 198.18.0.0 - 198.19.255.255)
  if (norm.startsWith("198.18.") || norm.startsWith("198.19.")) {
    return true;
  }
  // Multicast and reserved ranges (224.0.0.0/4 to 255.255.255.255)
  const parts = norm.split(".");
  if (parts.length === 4) {
    const first = parseInt(parts[0], 10);
    if (!isNaN(first) && first >= 224 && first <= 255) {
      return true;
    }
  }
  // Carrier-grade NAT (100.64.0.0/10)
  if (norm.startsWith("100.")) {
    const second = parseInt(parts[1], 10);
    if (second >= 64 && second <= 127) return true;
  }
  // IPv6 ULA (fc00::/7) and link-local (fe80::/10 covers fe80..febf)
  if (norm.startsWith("fc") || norm.startsWith("fd") || /^fe[89ab]/i.test(norm)) {
    return true;
  }
  // NAT64 (64:ff9b::/96)
  if (norm.startsWith("64:ff9b:")) {
    return true;
  }
  // Non-::ffff: IPv4-in-IPv6 forms (e.g. ::127.0.0.1, ::10.0.0.1, ::ffff:0:192.168.1.1)
  const lastColon = norm.lastIndexOf(":");
  if (lastColon !== -1) {
    const tail = norm.slice(lastColon + 1);
    if (tail.split(".").length === 4 && isPrivateIp(tail)) {
      return true;
    }
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
  options: {
    ssrfAllowPrivate?: boolean;
    deps?: { resolve?: (host: string) => Promise<string[]> };
  } = {},
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
      if (options.deps?.resolve) {
        ips = await options.deps.resolve(hostname);
      } else {
        const records = await dns.lookup(hostname, { all: true });
        ips = records.map((r) => r.address);
      }
      if (!ips || ips.length === 0) {
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

export interface SafeSsrfFetchOptions {
  ssrfAllowPrivate?: boolean;
  deps?: {
    resolve?: (host: string) => Promise<string[]>;
  };
  maxRedirects?: number;
  _currentHop?: number;
}

export interface SafeSsrfResponse {
  status: number;
  ok: boolean;
  statusText: string;
  headers: Headers;
  bytes: Uint8Array;
  effectiveIp: string;
  text: () => Promise<string>;
  json: () => Promise<any>;
}

/**
 * Executes an HTTP fetch with strict SSRF revalidation on every request and manual redirect hop.
 * Connects exclusively through `pinnedFetch`, ensuring the socket never reaches an unvalidated address.
 */
export async function safeSsrfFetch(
  url: string | URL,
  init?: RequestInit,
  options: SafeSsrfFetchOptions = {},
): Promise<SafeSsrfResponse> {
  const urlStr = url.toString();
  const parsed = new URL(urlStr);

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`SSRF Blocked: Unsupported protocol "${parsed.protocol}" (only https and http permitted)`);
  }

  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname === "169.254.169.254" ||
    hostname === "metadata.google.internal" ||
    hostname.endsWith(".metadata.google.internal")
  ) {
    throw new Error("SSRF Blocked: Access to cloud metadata endpoints is permanently forbidden");
  }

  // 1. Resolve hostname
  let ips: string[] = [];
  if (net.isIP(hostname)) {
    ips = [hostname];
  } else if (hostname === "localhost") {
    ips = ["127.0.0.1"];
  } else {
    try {
      if (options.deps?.resolve) {
        ips = await options.deps.resolve(hostname);
      } else {
        const records = await dns.lookup(hostname, { all: true });
        ips = records.map((r) => r.address);
      }
      if (!ips || ips.length === 0) {
        throw new Error(`DNS lookup returned no IP addresses for hostname "${hostname}"`);
      }
    } catch (err: any) {
      throw new Error(`SSRF Blocked: DNS resolution failed for hostname "${hostname}": ${err.message}`);
    }
  }

  // 2. Validate every resolved address
  for (const rawIp of ips) {
    const ip = normalizeIp(rawIp);
    if (isMetadataIp(ip)) {
      throw new Error("SSRF Blocked: Access to cloud metadata endpoints is permanently forbidden");
    }
    if (isPrivateIp(ip) && !options.ssrfAllowPrivate) {
      throw new Error(
        `SSRF Blocked: Access to private/local address "${ip}" is blocked (requires ssrfAllowPrivate: true)`,
      );
    }
  }

  // 3. Connect through pinnedFetch
  const reqHeaders: Record<string, string> = {};
  if (init?.headers) {
    if (init.headers instanceof Headers) {
      init.headers.forEach((v, k) => {
        reqHeaders[k] = v;
      });
    } else if (Array.isArray(init.headers)) {
      for (const [k, v] of init.headers) {
        reqHeaders[k] = v;
      }
    } else {
      Object.assign(reqHeaders, init.headers);
    }
  }

  let bodyBytes: Uint8Array | undefined;
  if (init?.body) {
    if (typeof init.body === "string") {
      bodyBytes = new TextEncoder().encode(init.body);
    } else if (init.body instanceof Uint8Array) {
      bodyBytes = init.body;
    } else if (init.body instanceof ArrayBuffer) {
      bodyBytes = new Uint8Array(init.body);
    }
  }

  const pinnedRes = await pinnedFetch({
    url: urlStr,
    ips,
    method: init?.method,
    headers: reqHeaders,
    body: bodyBytes,
    signal: init?.signal as AbortSignal | undefined,
  });

  // 4. Handle redirects
  if (pinnedRes.status >= 300 && pinnedRes.status < 400) {
    const location = pinnedRes.headers["location"];
    if (location) {
      const currentHop = options._currentHop ?? 0;
      if (currentHop >= (options.maxRedirects ?? 5)) {
        throw new Error("SSRF Blocked: Maximum redirect hops (5) exceeded");
      }
      const redirectUrl = new URL(location, urlStr).toString();
      return safeSsrfFetch(redirectUrl, init, {
        ...options,
        _currentHop: currentHop + 1,
      });
    }
  }

  return {
    status: pinnedRes.status,
    ok: pinnedRes.status >= 200 && pinnedRes.status < 300,
    statusText: pinnedRes.status === 200 ? "OK" : "",
    headers: new Headers(pinnedRes.headers),
    bytes: pinnedRes.bytes,
    effectiveIp: pinnedRes.effectiveIp,
    text: async () => new TextDecoder().decode(pinnedRes.bytes),
    json: async () => JSON.parse(new TextDecoder().decode(pinnedRes.bytes)),
  };
}
