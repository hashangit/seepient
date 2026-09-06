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
 * Parses an IPv4 or IPv6 address into raw bytes.
 * Returns { family: 4, bytes: Uint8Array(4) } or { family: 6, bytes: Uint8Array(16) }, or null if invalid.
 */
export function parseIpToBytes(rawIp: string): { family: 4 | 6; bytes: Uint8Array } | null {
  let ip = rawIp.trim().toLowerCase();
  if (ip.startsWith("[") && ip.endsWith("]")) {
    ip = ip.slice(1, -1);
  }

  // IPv4 dotted-decimal
  if (net.isIPv4(ip)) {
    const parts = ip.split(".");
    if (parts.length === 4) {
      const bytes = new Uint8Array(4);
      for (let i = 0; i < 4; i++) {
        const n = parseInt(parts[i], 10);
        if (isNaN(n) || n < 0 || n > 255) return null;
        bytes[i] = n;
      }
      return { family: 4, bytes };
    }
  }

  // IPv6
  if (net.isIPv6(ip) || ip.includes(":")) {
    let embeddedV4Bytes: Uint8Array | null = null;
    const lastColon = ip.lastIndexOf(":");
    if (lastColon !== -1) {
      const tail = ip.slice(lastColon + 1);
      if (tail.includes(".") && net.isIPv4(tail)) {
        const v4Parts = tail.split(".");
        if (v4Parts.length === 4) {
          embeddedV4Bytes = new Uint8Array(4);
          for (let i = 0; i < 4; i++) {
            embeddedV4Bytes[i] = parseInt(v4Parts[i], 10);
          }
          ip = ip.slice(0, lastColon);
          if (ip.endsWith(":")) {
            ip += ":";
          }
        }
      }
    }

    const doubleColonCount = ip.split("::").length - 1;
    if (doubleColonCount > 1) return null;

    let leftParts: string[] = [];
    let rightParts: string[] = [];

    if (doubleColonCount === 1) {
      const [left, right] = ip.split("::");
      leftParts = left ? left.split(":") : [];
      rightParts = right ? right.split(":") : [];
    } else {
      leftParts = ip.split(":");
    }

    const totalWordsExpected = embeddedV4Bytes ? 6 : 8;
    const specifiedWordsCount = leftParts.length + rightParts.length;
    if (doubleColonCount === 0 && specifiedWordsCount !== totalWordsExpected) {
      return null;
    }
    if (specifiedWordsCount > totalWordsExpected) {
      return null;
    }

    const words: number[] = [];
    for (const p of leftParts) {
      const val = parseInt(p, 16);
      if (isNaN(val) || val < 0 || val > 0xffff) return null;
      words.push(val);
    }
    const zeroWordsNeeded = totalWordsExpected - specifiedWordsCount;
    for (let i = 0; i < zeroWordsNeeded; i++) {
      words.push(0);
    }
    for (const p of rightParts) {
      const val = parseInt(p, 16);
      if (isNaN(val) || val < 0 || val > 0xffff) return null;
      words.push(val);
    }

    const bytes = new Uint8Array(16);
    for (let i = 0; i < totalWordsExpected; i++) {
      bytes[i * 2] = (words[i] >> 8) & 0xff;
      bytes[i * 2 + 1] = words[i] & 0xff;
    }
    if (embeddedV4Bytes) {
      bytes[12] = embeddedV4Bytes[0];
      bytes[13] = embeddedV4Bytes[1];
      bytes[14] = embeddedV4Bytes[2];
      bytes[15] = embeddedV4Bytes[3];
    }
    return { family: 6, bytes };
  }

  return null;
}

/**
 * Checks if 4 IPv4 bytes represent a private, loopback, link-local, or reserved address.
 */
export function isPrivateIpv4Bytes(b: Uint8Array, offset = 0): boolean {
  const b0 = b[offset];
  const b1 = b[offset + 1];
  const b2 = b[offset + 2];

  // 0.0.0.0/8 (Current network)
  if (b0 === 0) return true;
  // 10.0.0.0/8 (Private-Use RFC 1918)
  if (b0 === 10) return true;
  // 127.0.0.0/8 (Loopback)
  if (b0 === 127) return true;
  // 100.64.0.0/10 (Shared Address Space / CGNAT RFC 6598: 100.64.0.0 - 100.127.255.255)
  if (b0 === 100 && b1 >= 64 && b1 <= 127) return true;
  // 169.254.0.0/16 (Link Local RFC 3927)
  if (b0 === 169 && b1 === 254) return true;
  // 172.16.0.0/12 (Private-Use RFC 1918: 172.16.0.0 - 172.31.255.255)
  if (b0 === 172 && b1 >= 16 && b1 <= 31) return true;
  // 192.0.0.0/24 (IETF Protocol Assignments RFC 6890)
  if (b0 === 192 && b1 === 0 && b2 === 0) return true;
  // 192.168.0.0/16 (Private-Use RFC 1918)
  if (b0 === 192 && b1 === 168) return true;
  // 198.18.0.0/15 (Benchmarking RFC 2544: 198.18.0.0 - 198.19.255.255)
  if (b0 === 198 && (b1 === 18 || b1 === 19)) return true;
  // 224.0.0.0/4 (Multicast) and 240.0.0.0/4 (Reserved / Broadcast) -> b0 >= 224
  if (b0 >= 224) return true;

  return false;
}

/**
 * Normalizes an IPv4 or IPv6 address, unmapping IPv4-mapped IPv6 formats
 * (e.g. ::ffff:10.0.0.1 or ::ffff:a9fe:a9fe -> 169.254.169.254) as well as
 * SIIT (::ffff:0:a.b.c.d).
 */
export function normalizeIp(ip: string): string {
  const parsed = parseIpToBytes(ip);
  if (!parsed) return ip.trim().toLowerCase().replace(/^\[|\]$/g, "");

  if (parsed.family === 4) {
    return `${parsed.bytes[0]}.${parsed.bytes[1]}.${parsed.bytes[2]}.${parsed.bytes[3]}`;
  }

  const b = parsed.bytes;
  const isV4Mapped =
    b.slice(0, 10).every((v) => v === 0) && b[10] === 0xff && b[11] === 0xff;
  const isSiit =
    b.slice(0, 8).every((v) => v === 0) &&
    b[8] === 0xff &&
    b[9] === 0xff &&
    b[10] === 0 &&
    b[11] === 0;

  if (isV4Mapped || isSiit) {
    return `${b[12]}.${b[13]}.${b[14]}.${b[15]}`;
  }

  return ip.trim().toLowerCase().replace(/^\[|\]$/g, "");
}

export function isPrivateIp(ip: string): boolean {
  const parsed = parseIpToBytes(ip);
  if (!parsed) {
    const norm = normalizeIp(ip);
    return norm === "0.0.0.0" || norm === "::" || norm === "::1" || norm.startsWith("127.");
  }

  if (parsed.family === 4) {
    return isPrivateIpv4Bytes(parsed.bytes, 0);
  }

  const b = parsed.bytes;

  // 1. Unspecified :: (all zeroes)
  if (b.every((v) => v === 0)) return true;

  // 2. Loopback ::1 (15 zeroes followed by 1)
  if (b.slice(0, 15).every((v) => v === 0) && b[15] === 1) return true;

  // 3. IPv4-compatible (::/96: bytes 0..11 all 0)
  // W012: `::/96` (IPv4-compatible, e.g. `::7f00:1`, `::a9fe:a9fe`) blocked except `::1`
  if (b.slice(0, 12).every((v) => v === 0)) {
    return true;
  }

  // 4. IPv4-mapped (::ffff:0:0/96: bytes 0..9 all 0, bytes 10..11 are 0xff)
  const isV4Mapped =
    b.slice(0, 10).every((v) => v === 0) && b[10] === 0xff && b[11] === 0xff;
  if (isV4Mapped) {
    return isPrivateIpv4Bytes(b, 12);
  }

  // 5. SIIT (::ffff:0:0:0/96: bytes 0..7 all 0, bytes 8..9 are 0xff, bytes 10..11 are 0)
  const isSiit =
    b.slice(0, 8).every((v) => v === 0) &&
    b[8] === 0xff &&
    b[9] === 0xff &&
    b[10] === 0 &&
    b[11] === 0;
  if (isSiit) {
    return isPrivateIpv4Bytes(b, 12);
  }

  // 6. NAT64 Well-Known Prefix (64:ff9b::/96, RFC 6052)
  // W012: keep NAT64 `64:ff9b::/96` deliberately private
  const isNat64Wkp =
    b[0] === 0x00 &&
    b[1] === 0x64 &&
    b[2] === 0xff &&
    b[3] === 0x9b &&
    b.slice(4, 12).every((v) => v === 0);
  if (isNat64Wkp) {
    return true;
  }

  // 7. Unique Local Addresses (fc00::/7, RFC 4193: covers fc00::/8 and fd00::/8)
  if ((b[0] & 0xfe) === 0xfc) {
    return true;
  }

  // 8. Link-Local Unicast (fe80::/10, RFC 4291: fe80..febf)
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) {
    return true;
  }

  // 9. Multicast (ff00::/8)
  if (b[0] === 0xff) {
    return true;
  }

  // 10. Discard Prefix (100::/64, RFC 6666)
  if (b[0] === 0x01 && b[1] === 0x00 && b.slice(2, 8).every((v) => v === 0)) {
    return true;
  }

  return false;
}

export function isMetadataIp(ip: string): boolean {
  const parsed = parseIpToBytes(ip);
  if (!parsed) {
    const lower = ip.trim().toLowerCase();
    return lower.startsWith("169.254.");
  }

  if (parsed.family === 4) {
    return parsed.bytes[0] === 169 && parsed.bytes[1] === 254;
  }

  const b = parsed.bytes;

  // AWS/OpenStack IPv6 metadata address: fd00:ec2::254
  if (
    b[0] === 0xfd &&
    b[1] === 0x00 &&
    b[2] === 0x0e &&
    b[3] === 0xc2 &&
    b.slice(4, 14).every((v) => v === 0) &&
    b[14] === 0x02 &&
    b[15] === 0x54
  ) {
    return true;
  }

  // Embedded IPv4 check in v4-mapped (::ffff:0:0/96), SIIT (::ffff:0:0:0/96), v4-compat (::/96), or NAT64 WKP (64:ff9b::/96)
  const isV4Mapped =
    b.slice(0, 10).every((v) => v === 0) && b[10] === 0xff && b[11] === 0xff;
  const isSiit =
    b.slice(0, 8).every((v) => v === 0) &&
    b[8] === 0xff &&
    b[9] === 0xff &&
    b[10] === 0 &&
    b[11] === 0;
  const isV4Compat = b.slice(0, 12).every((v) => v === 0);
  const isNat64Wkp =
    b[0] === 0x00 &&
    b[1] === 0x64 &&
    b[2] === 0xff &&
    b[3] === 0x9b &&
    b.slice(4, 12).every((v) => v === 0);

  if (isV4Mapped || isSiit || isV4Compat || isNat64Wkp) {
    return b[12] === 169 && b[13] === 254;
  }

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

  const rawHostname = parsed.hostname.toLowerCase();
  const hostname = rawHostname.startsWith("[") && rawHostname.endsWith("]")
    ? rawHostname.slice(1, -1)
    : rawHostname;

  // Explicit check for cloud metadata hostnames
  if (
    hostname === "169.254.169.254" ||
    hostname === "fd00:ec2::254" ||
    hostname === "metadata.google.internal" ||
    hostname.endsWith(".metadata.google.internal") ||
    isMetadataIp(hostname)
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
    if (isMetadataIp(rawIp) || isMetadataIp(ip)) {
      return { valid: false, error: "Access to cloud metadata endpoints is permanently forbidden" };
    }
    if ((isPrivateIp(rawIp) || isPrivateIp(ip)) && !options.ssrfAllowPrivate) {
      return {
        valid: false,
        error: `Access to private/local address "${rawIp}" is blocked (requires ssrfAllowPrivate: true)`,
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
  timeoutMs?: number;
  maxResponseBytes?: number;
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

  const rawHostname = parsed.hostname.toLowerCase();
  const hostname = rawHostname.startsWith("[") && rawHostname.endsWith("]")
    ? rawHostname.slice(1, -1)
    : rawHostname;

  if (
    hostname === "169.254.169.254" ||
    hostname === "fd00:ec2::254" ||
    hostname === "metadata.google.internal" ||
    hostname.endsWith(".metadata.google.internal") ||
    isMetadataIp(hostname)
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
    if (isMetadataIp(rawIp) || isMetadataIp(ip)) {
      throw new Error("SSRF Blocked: Access to cloud metadata endpoints is permanently forbidden");
    }
    if ((isPrivateIp(rawIp) || isPrivateIp(ip)) && !options.ssrfAllowPrivate) {
      throw new Error(
        `SSRF Blocked: Access to private/local address "${rawIp}" is blocked (requires ssrfAllowPrivate: true)`,
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
    timeoutMs: options.timeoutMs ?? 10_000,
    maxResponseBytes: options.maxResponseBytes ?? 10 * 1024 * 1024,
  });

  // 4. Handle redirects
  if (pinnedRes.status >= 300 && pinnedRes.status < 400) {
    const location = pinnedRes.headers["location"];
    if (location) {
      const currentHop = options._currentHop ?? 0;
      if (currentHop >= (options.maxRedirects ?? 5)) {
        throw new Error("SSRF Blocked: Maximum redirect hops (5) exceeded");
      }
      const currentParsed = new URL(urlStr);
      const targetParsed = new URL(location, urlStr);
      const redirectUrl = targetParsed.toString();

      let nextMethod = init?.method?.toUpperCase() ?? "GET";
      let nextBody = init?.body;

      // RFC 7231 §6.4: 301/302/303 downgrade to GET and strip body
      if (
        pinnedRes.status === 303 ||
        (nextMethod !== "GET" && nextMethod !== "HEAD" && (pinnedRes.status === 301 || pinnedRes.status === 302))
      ) {
        nextMethod = "GET";
        nextBody = undefined;
      }

      // Clone headers and sanitize
      const nextHeaders: Record<string, string> = { ...reqHeaders };

      // Strip Content-Length and Content-Type if body was stripped
      if (nextBody === undefined) {
        for (const k of Object.keys(nextHeaders)) {
          const lower = k.toLowerCase();
          if (lower === "content-length" || lower === "content-type") {
            delete nextHeaders[k];
          }
        }
      }

      // Cross-origin redirects strip Authorization, Cookie, api-key, and x-api-key
      if (currentParsed.origin !== targetParsed.origin) {
        for (const k of Object.keys(nextHeaders)) {
          const lower = k.toLowerCase();
          if (
            lower === "authorization" ||
            lower === "cookie" ||
            lower === "api-key" ||
            lower === "x-api-key"
          ) {
            delete nextHeaders[k];
          }
        }
      }

      const nextInit: RequestInit = {
        ...init,
        method: nextMethod,
        headers: nextHeaders,
        body: nextBody,
      };

      return safeSsrfFetch(redirectUrl, nextInit, {
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
