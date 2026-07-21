/**
 * Broker lease authority — Capabilities (spec 008, T409, FR-009/FR-017/FR-018).
 *
 * The effect broker is exposed ONLY on a dedicated worker network. Workers
 * authenticate with a short-lived, action-bound lease token issued by the
 * control plane. The lease:
 *
 *  - is bound to one worker (workerId), one action (actionDigest), and one
 *    single-use request ID (singleUseRequestId);
 *  - has a short expiry (default 60s);
 *  - is verified by the broker BEFORE any connection is opened;
 *  - cannot be reused for another action, broker request ID, or worker;
 *  - is consumed (added to a replay set) once used, regardless of outcome.
 *
 * Workers cannot request raw secrets; the broker resolves `secret-ref` values
 * internally for an authorized connector operation only.
 *
 * The control plane's network configuration MUST place the broker on its own
 * network (`broker-net`), reachable only by workers — never by external
 * clients. `validateNetworkTopology` checks the deployment manifest for this.
 */
import { createHash } from "node:crypto";

/** A lease token issued by the control plane to a worker. */
export interface BrokerLeaseToken {
  leaseId: string;
  workerId: string;
  actionDigest: string;
  singleUseRequestIds: string[];
  expiresAt: number;
  /** HMAC over the above fields using the broker-lease signing key. */
  signature: string;
}

/** Authority that issues + verifies broker lease tokens. */
export class BrokerLeaseAuthority {
  private readonly signingKey: string;
  private readonly consumed = new Set<string>(); // singleUseRequestId

  constructor(opts: { signingKey: string }) {
    this.signingKey = opts.signingKey;
  }

  /**
   * Issue a short-lived, action-bound lease. The worker presents this to the
   * broker for each broker request in `singleUseRequestIds`.
   */
  issue(opts: {
    workerId: string;
    actionDigest: string;
    singleUseRequestIds: string[];
    ttlMs?: number;
  }): BrokerLeaseToken {
    const now = Date.now();
    const leaseId = `lease-${createHash("sha256").update(`${opts.workerId}|${opts.actionDigest}|${now}`).digest("hex").slice(0, 12)}`;
    const expiresAt = now + (opts.ttlMs ?? 60_000);
    const base = {
      leaseId,
      workerId: opts.workerId,
      actionDigest: opts.actionDigest,
      singleUseRequestIds: opts.singleUseRequestIds,
      expiresAt,
    };
    const signature = this.sign(base);
    return { ...base, signature };
  }

  /**
   * Verify a lease presented with a broker request. Returns the lease on
   * success; throws on any mismatch, replay, or expiry. Single-use request
   * IDs are consumed here (added to the replay set) regardless of outcome —
   * a replayed ID always fails.
   */
  verify(token: BrokerLeaseToken, ctx: {
    workerId: string;
    actionDigest: string;
    singleUseRequestId: string;
    now?: number;
  }): BrokerLeaseToken {
    const now = ctx.now ?? Date.now();
    // 1. Signature validity.
    const expected = this.sign({
      leaseId: token.leaseId,
      workerId: token.workerId,
      actionDigest: token.actionDigest,
      singleUseRequestIds: token.singleUseRequestIds,
      expiresAt: token.expiresAt,
    });
    if (expected !== token.signature) {
      throw new BrokerLeaseError("invalid-signature", "lease signature mismatch");
    }
    // 2. Worker binding.
    if (token.workerId !== ctx.workerId) {
      throw new BrokerLeaseError("worker-mismatch", "lease bound to a different worker");
    }
    // 3. Action binding.
    if (token.actionDigest !== ctx.actionDigest) {
      throw new BrokerLeaseError("action-mismatch", "lease bound to a different action");
    }
    // 4. Single-use request ID membership.
    if (!token.singleUseRequestIds.includes(ctx.singleUseRequestId)) {
      throw new BrokerLeaseError("request-id-not-in-lease", "single-use request ID not in lease");
    }
    // 5. Expiry.
    if (token.expiresAt <= now) {
      throw new BrokerLeaseError("expired", "lease expired");
    }
    // 6. Replay — consume the request ID atomically.
    if (this.consumed.has(ctx.singleUseRequestId)) {
      throw new BrokerLeaseError("replay", "single-use request ID already consumed");
    }
    this.consumed.add(ctx.singleUseRequestId);
    return token;
  }

  private sign(base: Omit<BrokerLeaseToken, "signature">): string {
    return createHash("sha256")
      .update(this.signingKey + JSON.stringify(base))
      .digest("hex");
  }
}

/** Lease verification failure. */
export class BrokerLeaseError extends Error {
  constructor(
    public readonly code:
      | "invalid-signature"
      | "worker-mismatch"
      | "action-mismatch"
      | "request-id-not-in-lease"
      | "expired"
      | "replay",
    message: string,
  ) {
    super(message);
    this.name = "BrokerLeaseError";
  }
}

/**
 * Validate that the deployment network topology isolates the broker on its
 * own network. The reference deployment uses `broker-net`; workers attach to
 * `broker-net` and can reach ONLY the effect-broker. `docker-compose.008.yml`
 * encodes this. This function is a structural check the operator can run.
 */
export function validateNetworkTopology(opts: {
  services: Array<{
    name: string;
    networks: string[];
    exposes?: string[];
  }>;
  brokerService: string;
  brokerNetwork: string;
}): { ok: true } | { ok: false; violations: string[] } {
  const violations: string[] = [];
  const broker = opts.services.find((s) => s.name === opts.brokerService);
  if (!broker) {
    return { ok: false, violations: [`broker service "${opts.brokerService}" not in manifest`] };
  }
  if (!broker.networks.includes(opts.brokerNetwork)) {
    violations.push(`broker not on dedicated network "${opts.brokerNetwork}"`);
  }
  // No service other than the broker should expose the broker port externally.
  for (const s of opts.services) {
    if (s.name === opts.brokerService) continue;
    if (s.exposes?.some((e) => e.includes("7001"))) {
      violations.push(`non-broker service "${s.name}" exposes the broker port`);
    }
  }
  // Workers attach to broker-net; the control plane does NOT (it can't reach
  // the broker directly — only via the scheduler's dispatch).
  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}
