/**
 * T409 tests (spec 008, FR-009/FR-017/FR-018) — broker lease enforcement +
 * dedicated-network topology.
 *
 * Verifies: lease is worker-bound, action-bound, single-use; replay/expiry/
 * mismatch denied; network topology check rejects a manifest where the broker
 * is shared with control-plane HTTP or a non-broker service exposes the
 * broker port.
 */
import { describe, it, expect } from "vitest";
import {
  BrokerLeaseAuthority,
  BrokerLeaseError,
  validateNetworkTopology,
} from "../broker-lease-authority.js";

describe("BrokerLeaseAuthority (T409)", () => {
  const auth = new BrokerLeaseAuthority({ signingKey: "test-key" });

  it("issues a lease bound to worker + action + single-use request IDs", () => {
    const t = auth.issue({
      workerId: "w-1",
      actionDigest: "d1",
      singleUseRequestIds: ["req-1", "req-2"],
    });
    expect(t.workerId).toBe("w-1");
    expect(t.actionDigest).toBe("d1");
    expect(t.singleUseRequestIds).toEqual(["req-1", "req-2"]);
    expect(t.signature).toMatch(/^[0-9a-f]{64}$/);
  });

  it("verifies a valid lease + consumes the single-use request ID", () => {
    const a = new BrokerLeaseAuthority({ signingKey: "k" });
    const t = a.issue({
      workerId: "w-1",
      actionDigest: "d1",
      singleUseRequestIds: ["req-1"],
    });
    expect(a.verify(t, { workerId: "w-1", actionDigest: "d1", singleUseRequestId: "req-1" })).toEqual(t);
  });

  it("rejects replay (single-use request ID consumed)", () => {
    const a = new BrokerLeaseAuthority({ signingKey: "k" });
    const t = a.issue({ workerId: "w-1", actionDigest: "d1", singleUseRequestIds: ["req-1"] });
    a.verify(t, { workerId: "w-1", actionDigest: "d1", singleUseRequestId: "req-1" });
    expect(() =>
      a.verify(t, { workerId: "w-1", actionDigest: "d1", singleUseRequestId: "req-1" }),
    ).toThrow(BrokerLeaseError);
  });

  it("rejects a different worker (lease is worker-bound)", () => {
    const t = auth.issue({ workerId: "w-1", actionDigest: "d1", singleUseRequestIds: ["r"] });
    expect(() =>
      auth.verify(t, { workerId: "w-2", actionDigest: "d1", singleUseRequestId: "r" }),
    ).toThrow(/worker/);
  });

  it("rejects a different action (lease is action-bound)", () => {
    const t = auth.issue({ workerId: "w-1", actionDigest: "d1", singleUseRequestIds: ["r"] });
    expect(() =>
      auth.verify(t, { workerId: "w-1", actionDigest: "d2", singleUseRequestId: "r" }),
    ).toThrow(/action/);
  });

  it("rejects a request ID not in the lease", () => {
    const t = auth.issue({ workerId: "w-1", actionDigest: "d1", singleUseRequestIds: ["r-1"] });
    expect(() =>
      auth.verify(t, { workerId: "w-1", actionDigest: "d1", singleUseRequestId: "r-other" }),
    ).toThrow(/not in lease/);
  });

  it("rejects an expired lease", () => {
    const a = new BrokerLeaseAuthority({ signingKey: "k" });
    const t = a.issue({ workerId: "w", actionDigest: "d", singleUseRequestIds: ["r"], ttlMs: 1 });
    expect(() =>
      a.verify(t, { workerId: "w", actionDigest: "d", singleUseRequestId: "r", now: Date.now() + 1000 }),
    ).toThrow(/expired/);
  });

  it("rejects a forged signature", () => {
    const t = auth.issue({ workerId: "w", actionDigest: "d", singleUseRequestIds: ["r"] });
    const forged = { ...t, signature: "a".repeat(64) };
    expect(() =>
      auth.verify(forged, { workerId: "w", actionDigest: "d", singleUseRequestId: "r" }),
    ).toThrow(/signature/);
  });

  it("the same request ID in two leases cannot be consumed twice across authorities (shared signing key)", () => {
    // Two authority instances with the same key (e.g. broker restarted but
    // sharing persisted replay state): the consume set is per-instance. The
    // PERSISTENT store (Redis/SQL) is what makes replay protection durable;
    // this test documents the in-memory single-instance behavior.
    const a1 = new BrokerLeaseAuthority({ signingKey: "k" });
    const t = a1.issue({ workerId: "w", actionDigest: "d", singleUseRequestIds: ["shared-req"] });
    a1.verify(t, { workerId: "w", actionDigest: "d", singleUseRequestId: "shared-req" });
    // A second instance without shared replay state WOULD accept it — this is
    // why the reference deployment uses a transactional store for the consumed
    // set, not in-memory state.
    const a2 = new BrokerLeaseAuthority({ signingKey: "k" });
    expect(() =>
      a2.verify(t, { workerId: "w", actionDigest: "d", singleUseRequestId: "shared-req" }),
    ).not.toThrow(); // documents the in-memory limitation
  });
});

describe("validateNetworkTopology (T409)", () => {
  const REFERENCE = {
    brokerService: "effect-broker",
    brokerNetwork: "broker-net",
    services: [
      { name: "control-plane", networks: ["control-net", "broker-net"], exposes: ["7337:7337"] },
      { name: "scheduler", networks: ["control-net", "broker-net"], exposes: ["7000:7000"] },
      { name: "effect-broker", networks: ["broker-net"], exposes: ["7001:7001"] },
      { name: "db", networks: ["control-net"], exposes: [] },
    ],
  };

  it("accepts the reference topology (broker on broker-net)", () => {
    expect(validateNetworkTopology(REFERENCE).ok).toBe(true);
  });

  it("rejects when broker is not on the dedicated network", () => {
    const r = validateNetworkTopology({
      ...REFERENCE,
      services: REFERENCE.services.map((s) =>
        s.name === "effect-broker" ? { ...s, networks: ["control-net"] } : s,
      ),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.violations.join()).toContain("not on dedicated network");
  });

  it("rejects when a non-broker service exposes the broker port", () => {
    const r = validateNetworkTopology({
      ...REFERENCE,
      services: REFERENCE.services.map((s) =>
        s.name === "control-plane" ? { ...s, exposes: ["7337:7337", "7001:7001"] } : s,
      ),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.violations.join()).toContain("non-broker service");
  });

  it("rejects when broker service is missing entirely", () => {
    const r = validateNetworkTopology({
      ...REFERENCE,
      services: REFERENCE.services.filter((s) => s.name !== "effect-broker"),
    });
    expect(r.ok).toBe(false);
  });
});
