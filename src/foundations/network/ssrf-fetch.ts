/**
 * SSRF-validated fetch (021-4 W141/W142/W144).
 *
 * Single shared "pinned/validated fetch path" for every surface that fetches
 * model- or user-supplied URLs: transport SSRF validation, gateway OpenAPI
 * import + REST calls, and embedder tooling. Enforces fail-closed DNS
 * resolution, private/reserved/metadata IP denial via the foundations
 * classifier, pinned-socket connects, and a cross-hop absolute deadline.
 * Policy + mechanism both live in foundations so every layer can import them.
 */

import * as dns from "node:dns/promises";
import * as net from "node:net";
import { pinnedFetch } from "./pinned-fetch.js";
import {
  isMetadataIp,
  isPrivateIp,
  normalizeIp,
} from "./ip-classifier.js";

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
    hostname === "100.100.100.200" ||
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
  /** Absolute wall-clock budget for the whole request incl. all redirect hops. Default: timeoutMs × (maxRedirects + 1). */
  overallTimeoutMs?: number;
  _currentHop?: number;
  _deadlineAt?: number;
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
 * W144: an absolute deadline bounds the total request across all redirect hops.
 */
export async function safeSsrfFetch(
  url: string | URL,
  init?: RequestInit,
  options: SafeSsrfFetchOptions = {},
): Promise<SafeSsrfResponse> {
  const urlStr = url.toString();
  const parsed = new URL(urlStr);

  const maxRedirects = options.maxRedirects ?? 5;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const deadlineAt = options._deadlineAt ?? Date.now() + (options.overallTimeoutMs ?? timeoutMs * (maxRedirects + 1));

  if (deadlineAt - Date.now() <= 0) {
    throw new Error("SSRF Blocked: overall request deadline exceeded across redirect hops");
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`SSRF Blocked: Unsupported protocol "${parsed.protocol}" (only https and http permitted)`);
  }

  const rawHostname = parsed.hostname.toLowerCase();
  const hostname = rawHostname.startsWith("[") && rawHostname.endsWith("]")
    ? rawHostname.slice(1, -1)
    : rawHostname;

  if (
    hostname === "169.254.169.254" ||
    hostname === "100.100.100.200" ||
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

  // 3. Connect through pinnedFetch — per-hop timeout never exceeds the
  // remaining overall budget (W144).
  const remainingMs = deadlineAt - Date.now();
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

  let pinnedRes: Awaited<ReturnType<typeof pinnedFetch>>;
  try {
    pinnedRes = await pinnedFetch({
      url: urlStr,
      ips,
      method: init?.method,
      headers: reqHeaders,
      body: bodyBytes,
      signal: init?.signal as AbortSignal | undefined,
      timeoutMs: Math.max(1, Math.min(timeoutMs, remainingMs)),
      maxResponseBytes: options.maxResponseBytes ?? 10 * 1024 * 1024,
    });
  } catch (err) {
    // A per-hop timeout that fires because the overall budget ran out is
    // reported as the deadline error (W144), not a per-hop timeout.
    if (Date.now() >= deadlineAt) {
      throw new Error("SSRF Blocked: overall request deadline exceeded across redirect hops");
    }
    throw err;
  }

  // 4. Handle redirects
  if (pinnedRes.status >= 300 && pinnedRes.status < 400) {
    const location = pinnedRes.headers["location"];
    if (location) {
      const currentHop = options._currentHop ?? 0;
      if (currentHop >= maxRedirects) {
        throw new Error(`SSRF Blocked: Maximum redirect hops (${maxRedirects}) exceeded`);
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
        _deadlineAt: deadlineAt,
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
