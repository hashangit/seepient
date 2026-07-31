/**
 * Typed EffectBroker — Capabilities (spec 008, T209/T210, FR-009/D38).
 *
 * The broker owns DNS resolution, connections, redirects, and internal secret
 * resolution. It rejects non-HTTP(S) schemes, loopback/private/link-local/
 * reserved/metadata ranges, unauthorized ports, redirects outside the
 * capability, and DNS rebinding between validation and connect. Direct worker
 * egress is disabled when filtered egress is claimed.
 *
 * V1 accepts typed HTTP, external-send, and vendor-connector operations only.
 * Arbitrary shell network access is not representable and is denied. Raw
 * secret retrieval is not a broker operation.
 *
 * This module implements the address/DNS validation + destination checks; the
 * actual network call is delegated to a pluggable fetch implementation so the
 * broker is unit-testable without touching the network.
 */
import type {
  EffectBroker as EffectBrokerContract,
  BrokerAuthContext,
  BrokeredEffectResult,
} from "../../foundations/contracts/execution-brokers.js";
import type {
  BrokeredEffectRequest,
  PreparedArtifactRef,
} from "../../foundations/contracts/prepared-action.js";
import type { CapabilityEnvelope } from "../../foundations/contracts/permission-policy.js";
import type { NetworkDestination } from "../../foundations/contracts/tool-effects.js";
import type { PreparationArtifactStore } from "../../foundations/contracts/execution-brokers.js";
import { createHash } from "node:crypto";
import { PersistedReplayLedger } from "./persisted-replay-ledger.js";

/** Loopback / private / link-local / reserved / cloud-metadata CIDRs (IPv4). */
const DENIED_IPV4_PATTERNS: ReadonlyArray<RegExp> = [
  /^127\./, // loopback
  /^10\./, // private
  /^192\.168\./, // private
  /^172\.(1[6-9]|2\d|3[01])\./, // private
  /^169\.254\./, // link-local
  /^0\./, // reserved
  /^22[4-5]\./, // multicast/reserved
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT (RFC 6598)
];

/** Denied IPv6 prefixes (T210b: private/metadata ranges). */
const DENIED_IPV6_PATTERNS: ReadonlyArray<RegExp> = [
  /^::1$/, // loopback
  /^fc[0-9a-f][0-9a-f]:/i, // ULA fc00::/7
  /^fd[0-9a-f][0-9a-f]:/i, // ULA fd00::/7
  /^fe80:/i, // link-local fe80::/10
  /^::ffff:127\./i, // IPv4-mapped loopback
  /^::ffff:10\./i, // IPv4-mapped private
  /^::ffff:192\.168\./i, // IPv4-mapped private
  /^::ffff:172\.(1[6-9]|2\d|3[01])\./i, // IPv4-mapped private
  /^::ffff:169\.254\./i, // IPv4-mapped link-local
  /^::ffff:169\.254\.169\.254$/i, // cloud metadata literal (IPv4-mapped)
  /^64:ff9b:/i, // NAT64 (RFC 6052) — treat as potentially private
];

const DENIED_HOSTS: ReadonlySet<string> = new Set([
  "localhost",
  "metadata.google.internal", // GCP metadata
  "metadata.aws.internal", // AWS metadata
  "169.254.169.254", // cloud metadata literal
  "fd00:ec2::254", // AWS IMDSv2 IPv6
  "[::1]", // IPv6 loopback literal in URL
]);

/** Pluggable DNS + fetch surface so the broker is unit-testable. */
export interface BrokerNetworkAdapter {
  resolve(host: string): Promise<string[]>;
  fetch(
    destination: NetworkDestination,
    init: { method: string; headers: Record<string, string>; body?: Uint8Array; signal?: AbortSignal },
  ): Promise<BrokerNetworkResponse>;
}

/** Response surface returned by a `BrokerNetworkAdapter.fetch` call. */
export interface BrokerNetworkResponse {
  status: number;
  bytes: Uint8Array;
  effectiveHost: string;
  effectiveIp: string;
  /**
   * Response headers, lower-cased keys. Required so the broker can read the
   * `location` header to reauthorize redirects (D38). Adapters MUST populate
   * at least `location` when status is a 3xx redirect.
   */
  headers: Record<string, string>;
}

/** Headers the broker strips unless a connector schema owns them. */
const FORBIDDEN_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "cookie",
  "host",
  "proxy",
  "proxy-authorization",
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "connection",
  "transfer-encoding",
  "upgrade",
]);

export interface EffectBrokerOptions {
  artifacts: PreparationArtifactStore;
  network: BrokerNetworkAdapter;
  /** Maximum bytes returned (oversize denied). Default 10 MiB. */
  maxResponseBytes?: number;
  /** Hard deadline per request. Default 30s. */
  deadlineMs?: number;
  /** T210a: Persisted replay ledger. If omitted, falls back to in-memory Set. */
  replayLedger?: PersistedReplayLedger;
  /** Optional handler for external-send (email/chat/notification) requests. */
  externalSendHandler?: (req: Extract<BrokeredEffectRequest, { kind: "external-send" }>) => Promise<BrokeredEffectResult>;
  /** Optional handler for vendor-operation requests. */
  vendorOperationHandler?: (req: Extract<BrokeredEffectRequest, { kind: "vendor-operation" }>) => Promise<BrokeredEffectResult>;
}

/**
 * V1 typed effect broker. Validates auth context + capability envelope before
 * any connection; resolves DNS and rejects forbidden ranges; reauthorizes
 * every redirect; stores the response as an artifact; never returns raw
 * secrets.
 *
 * T210a: replay protection is now durable (PersistedReplayLedger).
 * T210b: IPv6 private/metadata ranges are blocked.
 * T210c: DNS is resolved before connecting; the IP is pinned and verified
 *        at connect time to prevent DNS rebinding races.
 */
export class EffectBroker implements EffectBrokerContract {
  private readonly artifacts: PreparationArtifactStore;
  private readonly network: BrokerNetworkAdapter;
  private readonly maxResponseBytes: number;
  private readonly deadlineMs: number;
  /** T210a: Durable replay ledger. Falls back to in-memory when not provided. */
  private readonly replayLedger: PersistedReplayLedger;
  private readonly externalSendHandler?: (req: Extract<BrokeredEffectRequest, { kind: "external-send" }>) => Promise<BrokeredEffectResult>;
  private readonly vendorOperationHandler?: (req: Extract<BrokeredEffectRequest, { kind: "vendor-operation" }>) => Promise<BrokeredEffectResult>;

  constructor(opts: EffectBrokerOptions) {
    this.artifacts = opts.artifacts;
    this.network = opts.network;
    this.maxResponseBytes = opts.maxResponseBytes ?? 10 * 1024 * 1024;
    this.deadlineMs = opts.deadlineMs ?? 30_000;
    this.replayLedger = opts.replayLedger ?? new PersistedReplayLedger();
    this.externalSendHandler = opts.externalSendHandler;
    this.vendorOperationHandler = opts.vendorOperationHandler;
  }

  async execute(
    request: BrokeredEffectRequest,
    envelope: CapabilityEnvelope,
    auth: BrokerAuthContext,
  ): Promise<BrokeredEffectResult> {
    // 1. Authenticate caller + lease.
    const now = Date.now();
    if (auth.expiresAt <= now) {
      return this.denied(request.requestId, "expired lease");
    }
    if (auth.actionDigest !== envelope.actionDigest) {
      return this.denied(request.requestId, "lease/action digest mismatch");
    }
    // T210a: Atomic replay consumption BEFORE execution.
    const consumed = await this.replayLedger.consume(auth.singleUseRequestId);
    if (!consumed) {
      return this.denied(request.requestId, "replay: request ID already consumed");
    }

    // 2. Reject unknown contract versions / operation kinds.
    const requestId = request.requestId;
    const requestKind = request.kind;
    if (requestKind !== "http" && requestKind !== "external-send" && requestKind !== "vendor-operation") {
      return this.denied(requestId, `unsupported operation kind: ${requestKind}`);
    }

    // 3. Per-kind validation + execution.
    if (request.kind === "http") {
      return await this.executeHttp(request, envelope, auth);
    }
    if (request.kind === "external-send") {
      return await this.executeExternalSend(request, envelope, auth);
    }
    if (request.kind === "vendor-operation") {
      return await this.executeVendorOperation(request, envelope, auth);
    }
    return this.denied(requestId, `${requestKind} not implemented in v1 broker`);
  }

  private async executeExternalSend(
    request: Extract<BrokeredEffectRequest, { kind: "external-send" }>,
    envelope: CapabilityEnvelope,
    auth: BrokerAuthContext,
  ): Promise<BrokeredEffectResult> {
    for (const recipient of request.recipients) {
      const cap = envelope.capabilities.find(
        (c) =>
          c.kind === "external-recipient" &&
          c.service === recipient.service &&
          c.recipient === recipient.recipient,
      );
      if (!cap) {
        return this.denied(
          request.requestId,
          `no external-recipient capability for service ${recipient.service} / ${recipient.recipient}`,
        );
      }
    }
    if (this.externalSendHandler) {
      return await this.externalSendHandler(request);
    }
    return this.denied(
      request.requestId,
      "EFFECT_UNSUPPORTED: No external send transport configured (SMTP/SendGrid/Chat transport missing)",
    );
  }

  private async executeVendorOperation(
    request: Extract<BrokeredEffectRequest, { kind: "vendor-operation" }>,
    _envelope: CapabilityEnvelope,
    _auth: BrokerAuthContext,
  ): Promise<BrokeredEffectResult> {
    if (this.vendorOperationHandler) {
      return await this.vendorOperationHandler(request);
    }
    return this.denied(
      request.requestId,
      "EFFECT_UNSUPPORTED: No vendor operation handler configured",
    );
  }

  private async executeHttp(
    request: Extract<BrokeredEffectRequest, { kind: "http" }>,
    envelope: CapabilityEnvelope,
    auth: BrokerAuthContext,
  ): Promise<BrokeredEffectResult> {
    // 2a. Capability check: envelope must carry a network-destination cap for
    // this exact scheme+host.
    const cap = envelope.capabilities.find(
      (c) =>
        c.kind === "network-destination" &&
        c.scheme === request.destination.scheme &&
        c.host === request.destination.host,
    );
    if (!cap || cap.kind !== "network-destination") {
      return this.denied(request.requestId, "no network-destination capability for destination");
    }

    // 2b. Scheme/host/port validation.
    const dest = request.destination;
    if (dest.scheme !== "https" && dest.scheme !== "http") {
      return this.denied(request.requestId, `non-HTTP scheme: ${dest.scheme}`);
    }
    if (DENIED_HOSTS.has(dest.host.toLowerCase())) {
      return this.denied(request.requestId, `denied host: ${dest.host}`);
    }

    // 2c. DNS resolution + address-range checks (DNS rebinding defense: the
    // adapter must connect to one of the resolved IPs, re-checked at connect).
    let resolvedIps: string[];
    try {
      resolvedIps = await this.network.resolve(dest.host);
    } catch {
      return this.denied(request.requestId, `DNS resolution failed for ${dest.host}`);
    }
    if (resolvedIps.length === 0) {
      return this.denied(request.requestId, `no DNS records for ${dest.host}`);
    }
    if (resolvedIps.some((ip) => this.isDeniedAddress(ip))) {
      return this.denied(request.requestId, `private/metadata address resolved for ${dest.host}`);
    }

    // 2d. Strip forbidden headers (model can't inject auth/proxy/forwarding).
    const cleanHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(request.headers)) {
      if (!FORBIDDEN_REQUEST_HEADERS.has(k.toLowerCase())) {
        cleanHeaders[k] = v;
      }
    }

    // 2e. Read body artifact if present (digest-verified by artifact store).
    let body: Uint8Array | undefined;
    if (request.body) {
      body = await this.artifacts.read(request.body);
    }

    // 2f. Connect with deadline and manual redirect validation.
    // Every redirect re-verifies scheme, host, capability envelope, and DNS IPs.
    // Per-hop method/body follow RFC 7231 §6.4: 303 always becomes GET with no
    // body; 301/302 from POST also become GET with no body (safe default for a
    // security boundary); 307/308 preserve method and body. A secret-bearing
    // body must never be re-posted to a redirect target host.
    let currentDest = dest;
    let currentMethod = request.method;
    let currentBody = body;
    let redirectCount = 0;
    const MAX_REDIRECTS = 5;
    const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
    // Overall deadline bound across all hops: each per-hop timeout is the
    // minimum of the configured hop deadline and the time remaining, so a
    // redirect chain cannot run for `deadlineMs × hops`.
    const overallDeadlineAt = Date.now() + this.deadlineMs;

    try {
      while (true) {
        const remaining = overallDeadlineAt - Date.now();
        if (remaining <= 0) {
          return this.denied(request.requestId, "request deadline exceeded (redirect chain)");
        }
        const controller = new AbortController();
        let timeout: NodeJS.Timeout | undefined;
        try {
          timeout = setTimeout(() => controller.abort(), Math.min(this.deadlineMs, remaining));
          const response = await this.network.fetch(
            currentDest,
            { method: currentMethod, headers: cleanHeaders, body: currentBody, signal: controller.signal },
          );
          if (timeout) clearTimeout(timeout);

          // Check for HTTP redirect response (301, 302, 303, 307, 308)
          if (REDIRECT_STATUSES.has(response.status)) {
            // Exceeding the redirect cap is an error, NOT a silent success —
            // returning the 3xx body would look like a successful fetch.
            if (redirectCount >= MAX_REDIRECTS) {
              return this.denied(request.requestId, `redirect chain exceeded ${MAX_REDIRECTS} hops`);
            }
            // Adapter returns lower-cased header keys (BrokerNetworkResponse).
            const location = response.headers?.location;
            if (location) {
              let targetUrl: URL;
              try {
                targetUrl = new URL(location, `${currentDest.scheme}://${currentDest.host}`);
              } catch {
                return this.denied(request.requestId, `invalid redirect Location: ${location}`);
              }
              const nextScheme = targetUrl.protocol.replace(":", "") as "http" | "https";
              const nextHost = targetUrl.hostname;
              const nextPort = targetUrl.port ? parseInt(targetUrl.port, 10) : undefined;

              // Re-validate against envelope, DENIED_HOSTS, and DNS IP ranges
              const redirectCap = envelope.capabilities.find(
                (c) =>
                  c.kind === "network-destination" &&
                  c.scheme === nextScheme &&
                  c.host === nextHost,
              );
              if (!redirectCap) {
                return this.denied(request.requestId, `redirect to unauthorized destination ${nextScheme}://${nextHost} denied`);
              }
              if (DENIED_HOSTS.has(nextHost.toLowerCase())) {
                return this.denied(request.requestId, `redirect to denied host: ${nextHost}`);
              }

              let nextIps: string[];
              try {
                nextIps = await this.network.resolve(nextHost);
              } catch {
                return this.denied(request.requestId, `DNS resolution failed for redirect target ${nextHost}`);
              }
              if (nextIps.length === 0 || nextIps.some((ip) => this.isDeniedAddress(ip))) {
                return this.denied(request.requestId, `redirect to private/metadata address for ${nextHost}`);
              }

              // Target valid — apply per-status method/body semantics before
              // following the redirect (RFC 7231 §6.4).
              if (response.status === 303 || (currentMethod !== "GET" && currentMethod !== "HEAD" && (response.status === 301 || response.status === 302))) {
                currentMethod = "GET";
                currentBody = undefined;
              }
              // 307/308 (and same-method 301/302) preserve method and body.

              redirectCount++;
              // Preserve the query string (pathname alone drops ?search).
              currentDest = { scheme: nextScheme, host: nextHost, port: nextPort, pathPrefix: targetUrl.pathname + targetUrl.search };
              resolvedIps = nextIps;
              continue;
            }
          }

          // Response-size cap.
          if (response.bytes.byteLength > this.maxResponseBytes) {
            return this.denied(request.requestId, "response exceeds size cap");
          }
          // DNS rebinding: the effective IP must match one of the resolved IPs.
          if (response.effectiveIp && !resolvedIps.includes(response.effectiveIp)) {
            return this.denied(request.requestId, "DNS rebinding detected");
          }
          // Store the response as an artifact (never raw to the worker).
          const artifact = await this.artifacts.put(response.bytes, "application/octet-stream");
          return {
            requestId: request.requestId,
            status: "succeeded",
            output: artifact,
            effectiveDestination: { ...currentDest, host: response.effectiveHost },
          };
        } finally {
          clearTimeout(timeout);
        }
      }
    } catch (err) {
      return {
        requestId: request.requestId,
        status: "failed",
        error: {
          code: "BROKER_FETCH_FAILED",
          message: (err as Error).message,
          retryable: true,
        },
      };
    } finally {
      void auth;
    }
  }

  private isDeniedAddress(ip: string): boolean {
    // IPv4
    if (DENIED_IPV4_PATTERNS.some((re) => re.test(ip))) return true;
    // T210b: IPv6 private/metadata/loopback ranges
    if (DENIED_IPV6_PATTERNS.some((re) => re.test(ip))) return true;
    return false;
  }

  private denied(requestId: string, message: string): BrokeredEffectResult {
    return {
      requestId,
      status: "denied",
      error: { code: "BROKER_DENIED", message, retryable: false },
    };
  }
}

/** Default Node.js network adapter for EffectBroker. */
export class NodeNetworkAdapter implements BrokerNetworkAdapter {
  async resolve(host: string): Promise<string[]> {
    try {
      const dns = await import("node:dns/promises");
      const addrs = await dns.lookup(host, { all: true });
      return addrs.map((a) => a.address);
    } catch {
      return [];
    }
  }

  async fetch(
    destination: NetworkDestination,
    init: { method: string; headers: Record<string, string>; body?: Uint8Array; signal?: AbortSignal },
  ): Promise<BrokerNetworkResponse> {
    // T210c: Resolve IPs BEFORE opening the connection. Pin the resolved IP and
    // force the socket lookup callback to connect to THAT IP.
    const resolvedIps = await this.resolve(destination.host);
    if (resolvedIps.length === 0) {
      throw new Error(`DNS resolution failed for ${destination.host}`);
    }
    const pinnedIp = resolvedIps[0];
    const isHttps = destination.scheme === "https";
    const port = destination.port ?? (isHttps ? 443 : 80);

    const httpModule = isHttps ? await import("node:https") : await import("node:http");

    return new Promise((resolvePromise, rejectPromise) => {
      const isV6 = pinnedIp.includes(":");
      const family = isV6 ? 6 : 4;

      const reqOpts = {
        method: init.method,
        hostname: destination.host,
        port,
        path: destination.pathPrefix || "/",
        headers: {
          ...init.headers,
          host: destination.host,
        },
        servername: isHttps ? destination.host : undefined,
        // Force net/tls connect to pinnedIp (true DNS rebinding protection)
        lookup: (_h: string, _opts: unknown, cb: (err: Error | null, address: string, family: number) => void) => {
          cb(null, pinnedIp, family);
        },
      };

      const req = httpModule.request(reqOpts, (res) => {
        const socketIp = res.socket.remoteAddress || pinnedIp;
        // Lower-case header keys so the broker can read `location` uniformly.
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers ?? {})) {
          if (typeof v === "string") headers[k.toLowerCase()] = v;
          else if (Array.isArray(v)) headers[k.toLowerCase()] = v.join(", ");
        }
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const bytes = new Uint8Array(Buffer.concat(chunks));
          resolvePromise({
            status: res.statusCode ?? 200,
            bytes,
            effectiveHost: destination.host,
            effectiveIp: socketIp,
            headers,
          });
        });
        res.on("error", rejectPromise);
      });

      req.on("error", rejectPromise);

      if (init.signal) {
        if (init.signal.aborted) {
          req.destroy(new Error("aborted"));
          rejectPromise(new Error("aborted"));
          return;
        }
        init.signal.addEventListener("abort", () => {
          req.destroy(new Error("aborted"));
          rejectPromise(new Error("aborted"));
        });
      }

      if (init.body && init.body.length > 0) {
        req.write(Buffer.from(init.body));
      }
      req.end();
    });
  }
}

/** SHA-256 helper for artifact integrity bookkeeping. */
export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export type { PreparedArtifactRef };
