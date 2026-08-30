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
import { resolveSecretRef } from "../../foundations/security/credential-resolver.js";
import { createSetupFailure } from "../../foundations/contracts/setup-failure.js";

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
  /** Optional secret resolver for injecting credentials securely inside the broker. */
  secretResolver?: (ref: string) => string | undefined;
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
  private readonly secretResolver?: (ref: string) => string | undefined;

  constructor(opts: EffectBrokerOptions) {
    this.artifacts = opts.artifacts;
    this.network = opts.network;
    this.maxResponseBytes = opts.maxResponseBytes ?? 10 * 1024 * 1024;
    this.deadlineMs = opts.deadlineMs ?? 30_000;
    this.replayLedger = opts.replayLedger ?? new PersistedReplayLedger();
    this.externalSendHandler = opts.externalSendHandler;
    this.vendorOperationHandler = opts.vendorOperationHandler;
    this.secretResolver = opts.secretResolver;
  }

  private resolveSecret(ref: string): string | undefined {
    if (this.secretResolver) {
      const val = this.secretResolver(ref);
      if (val !== undefined) return val;
    }
    return resolveSecretRef(ref);
  }

  /**
   * Execute a prepared brokered effect. Enforces:
   *  1. Non-empty requestId, unconsumed single-use replay ticket.
   *  2. Exactly-once authorization context (actionDigest, lease unexpired).
   *  3. Capability envelope covers the destination/recipient/secret.
   *  4. DNS IP range / SSRF check.
   *  5. Redirects re-checked against the capability envelope.
   *  6. Response stored as artifact (not raw memory).
   */
  async execute(
    request: BrokeredEffectRequest,
    envelope: CapabilityEnvelope,
    auth: BrokerAuthContext,
  ): Promise<BrokeredEffectResult> {
    const requestId = request.requestId;
    if (!requestId || typeof requestId !== "string") {
      return this.denied(requestId ?? "", "missing or invalid requestId");
    }

    // 1a. Replay check (durable): each requestId can execute at most once.
    const consumed = await this.replayLedger.consume(requestId);
    if (!consumed) {
      return this.denied(requestId, `replay detected: requestId "${requestId}" was already executed`);
    }

    // 1b. Auth context: lease unexpired, actionDigest matches.
    if (Date.now() > auth.expiresAt) {
      return this.denied(requestId, "broker authorization lease expired");
    }
    if (auth.singleUseRequestId !== requestId) {
      return this.denied(requestId, "auth context singleUseRequestId mismatch");
    }
    if (envelope.actionDigest !== auth.actionDigest) {
      return this.denied(requestId, "capability envelope actionDigest mismatch");
    }

    const requestKind = request.kind;
    if (requestKind === "http") {
      return await this.executeHttp(request, envelope, auth);
    }
    if (requestKind === "external-send") {
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
    _auth: BrokerAuthContext,
  ): Promise<BrokeredEffectResult> {
    for (const recipient of request.recipients) {
      const cap = envelope.capabilities.find(
        (c) =>
          c.kind === "external-recipient" &&
          (c.service === recipient.service || c.service === "*") &&
          (c.recipient === recipient.recipient || c.recipient === "*"),
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
    try {
      return await this.defaultExternalSend(request);
    } catch (err) {
      return {
        requestId: request.requestId,
        status: "failed",
        error: {
          code: "EXTERNAL_SEND_FAILED",
          message: (err as Error).message,
          retryable: true,
        },
      };
    }
  }

  private async defaultExternalSend(
    request: Extract<BrokeredEffectRequest, { kind: "external-send" }>,
  ): Promise<BrokeredEffectResult> {
    let payloadText = "";
    if (request.payload) {
      const bytes = await this.artifacts.read(request.payload);
      payloadText = new TextDecoder().decode(bytes);
    }

    if (request.service === "smtp") {
      const host = this.resolveSecret("smtpHost");
      const port = parseInt(this.resolveSecret("smtpPort") || "587", 10);
      const user = this.resolveSecret("smtpUser");
      const pass = this.resolveSecret("smtpPass");
      const from = this.resolveSecret("smtpFrom") || user;

      if (!host || !user || !pass) {
        return this.denied(
          request.requestId,
          "SMTP configuration incomplete (missing smtpHost/smtpUser/smtpPass)",
        );
      }

      let emailSubject = (request as any).subject ?? "Seepient Notification";
      let emailBody = payloadText;
      try {
        const parsed = JSON.parse(payloadText);
        if (parsed && typeof parsed === "object") {
          if (parsed.subject) emailSubject = parsed.subject;
          if (parsed.body !== undefined) emailBody = String(parsed.body);
        }
      } catch {
        /* payloadText was raw plain text body */
      }

      const nodemailer = (await import("../../vendors/nodemailer.js")).default;
      const transporter = nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        auth: { user, pass },
      });

      const recipient = request.recipients[0]?.recipient ?? "";
      const info = await transporter.sendMail({
        from,
        to: recipient,
        subject: emailSubject,
        text: emailBody,
      });

      const outputBytes = new TextEncoder().encode(`Email sent successfully. Message ID: ${info.messageId}`);
      const artifact = await this.artifacts.put(outputBytes, "text/plain");
      return {
        requestId: request.requestId,
        status: "succeeded",
        output: artifact,
      };
    }

    if (request.service === "feishu" || request.service === "dingtalk" || request.service === "wecom") {
      const webhookUrl = this.resolveSecret(`${request.service}Webhook`);
      const keyword = this.resolveSecret(`${request.service}Keyword`);

      if (!webhookUrl) {
        return this.denied(
          request.requestId,
          `${request.service} webhook URL is not configured`,
        );
      }

      let content = payloadText;
      if (keyword && !content.includes(keyword)) {
        content = `[${keyword}] ${content}`;
      }

      let payload: Record<string, unknown>;
      if (request.service === "feishu") {
        payload = { msg_type: "text", content: { text: content } };
      } else {
        payload = { msgtype: "text", text: { content } };
      }

      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const result: any = await response.json().catch(() => ({}));
      const isSuccess =
        response.ok &&
        (request.service === "feishu" ? result.code === 0 : result.errcode === 0);

      if (!isSuccess) {
        return {
          requestId: request.requestId,
          status: "failed",
          error: {
            code: "EXTERNAL_SEND_FAILED",
            message: `Notification to ${request.service} failed (HTTP ${response.status}): ${JSON.stringify(result)}`,
            retryable: true,
          },
        };
      }

      const message = `Notification sent to ${request.service} successfully.`;
      const outputBytes = new TextEncoder().encode(message);
      const artifact = await this.artifacts.put(outputBytes, "text/plain");
      return {
        requestId: request.requestId,
        status: "succeeded",
        output: artifact,
      };
    }

    return this.denied(
      request.requestId,
      `EFFECT_UNSUPPORTED: Unsupported external send service "${request.service}"`,
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
    const setup = createSetupFailure(
      request.operation,
      `${request.connector} vendor operation handler`,
      "an AI provider runtime in /models or seepient.json",
    );
    return {
      requestId: request.requestId,
      status: "denied",
      error: {
        code: "SETUP_REQUIRED",
        message: setup.message,
        retryable: false,
      },
    };
  }

  private async executeHttp(
    request: Extract<BrokeredEffectRequest, { kind: "http" }>,
    envelope: CapabilityEnvelope,
    auth: BrokerAuthContext,
  ): Promise<BrokeredEffectResult> {
    // 2a. Envelope must authorize network-destination with matching scheme + host (exact or wildcard).
    const cap = envelope.capabilities.find(
      (c) =>
        c.kind === "network-destination" &&
        c.scheme === request.destination.scheme &&
        (c.host === request.destination.host || c.host === "*") &&
        (!c.port || c.port === request.destination.port),
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
    // 2e. Read body artifact if present (digest-verified by artifact store).
    let body: Uint8Array | undefined;
    if (request.body) {
      body = await this.artifacts.read(request.body);
    }

    let hasInjectedSecret = false;

    // 2e-ii. Inject authorized secret credentials for verified destinations & secretRefs.
    // Tavily authenticates via the Authorization Bearer header only (per their
    // API reference); the key is never duplicated into the request body.
    if (dest.host === "api.tavily.com" || request.secretRefs?.includes("tavilyApiKey")) {
      const tavilyKey = this.resolveSecret("tavilyApiKey");
      if (tavilyKey) {
        cleanHeaders["authorization"] = `Bearer ${tavilyKey}`;
        hasInjectedSecret = true;
      }
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
    let currentHeaders = { ...cleanHeaders };
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
            { method: currentMethod, headers: currentHeaders, body: currentBody, signal: controller.signal },
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

              // Cross-host redirect security:
              const isCrossHost = nextHost.toLowerCase() !== dest.host.toLowerCase();
              if (isCrossHost) {
                // Never forward secret-bearing body across hosts on 307/308
                if (hasInjectedSecret && (response.status === 307 || response.status === 308)) {
                  return this.denied(request.requestId, `refusing to forward secret-bearing body to cross-host redirect target: ${nextHost}`);
                }
                // Strip credentials on cross-host redirects
                delete currentHeaders["authorization"];
                delete currentHeaders["api-key"];
                delete currentHeaders["cookie"];
              }

              // Re-validate against envelope, DENIED_HOSTS, and DNS IP ranges
              const redirectCap = envelope.capabilities.find(
                (c) =>
                  c.kind === "network-destination" &&
                  c.scheme === nextScheme &&
                  (c.host === nextHost || c.host === "*") &&
                  (!c.port || c.port === nextPort),
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
            httpStatus: response.status,
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
      const allAddresses = resolvedIps.map((ip) => ({
        address: ip,
        family: ip.includes(":") ? 6 : 4,
      }));

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
        // Force net/tls connect to the pre-resolved IPs (true DNS rebinding
        // protection). Node >= 20 with autoSelectFamily requests the `all`
        // form and expects [{address, family}]; answering that request with
        // the legacy single-address form makes net throw
        // ERR_INVALID_IP_ADDRESS ("Invalid IP address: undefined").
        lookup: (
          _h: string,
          opts: { all?: boolean },
          cb: (
            err: Error | null,
            result: string | Array<{ address: string; family: number }>,
            family?: number,
          ) => void,
        ) => {
          if (opts?.all) cb(null, allAddresses);
          else cb(null, pinnedIp, family);
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
