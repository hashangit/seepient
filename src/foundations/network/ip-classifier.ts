/**
 * Pure IP classification primitives (021-4 W141).
 *
 * Single source of truth for "is this address private/reserved/metadata?",
 * shared by the transport SSRF validator, the effect broker, and the gateway
 * validated fetch. Pure functions only — no I/O, no layer imports.
 */

import * as net from "node:net";

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
    return lower.startsWith(METADATA_IP_PREFIX);
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
