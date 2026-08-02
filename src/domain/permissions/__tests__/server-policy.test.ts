/**
 * P4 server policy + durable approval store tests (spec 008, T401/T407/T408,
 * QS-4.1/QS-4.5).
 *
 * Verifies: monotonic server intersection, missing-principal fails closed,
 * request never expands authority, durable CAS terminal transitions, expiry
 * denial, idempotent duplicate rejection, ceiling reevaluation.
 */
import { describe, it, expect } from "vitest";
import {
  serverEffectiveCapabilities,
  serverCapabilityCovers,
} from "../server-policy.js";
import { PendingApprovalStore } from "../durable-approval-store.js";
import type {
  Capability,
  CapabilitySet,
  PermissionRequest,
} from "../../../foundations/contracts/permission-policy.js";

function set(...caps: Capability[]): CapabilitySet {
  return { version: 1, capabilities: caps };
}

function serverCtx(overrides: Partial<Parameters<typeof serverEffectiveCapabilities>[0]> = {}) {
  return {
    principalId: "user-1",
    tenantId: "t-1",
    sessionId: "s-1",
    deploymentCeiling: set({ kind: "commit-file", path: "/p/a.txt" }),
    principalPolicy: set({ kind: "commit-file", path: "/p/a.txt" }),
    workspacePolicy: set({ kind: "commit-file", path: "/p/a.txt" }),
    approvalMode: "remote" as const,
    ...overrides,
  };
}

describe("serverEffectiveCapabilities (T401, QS-4.1)", () => {
  it("intersects all layers monotonically", () => {
    const result = serverEffectiveCapabilities(serverCtx());
    expect(result.failed).toBe(false);
    expect(result.capabilities.capabilities).toHaveLength(1);
  });

  it("fails closed when principal policy is missing", () => {
    const result = serverEffectiveCapabilities(
      serverCtx({
        principalId: "anonymous",
        principalPolicy: set(),
      }),
    );
    expect(result.failed).toBe(true);
    if (result.failed) expect(result.failureReason).toBe("missing-principal-policy");
  });

  it("request restriction narrows principal (never expands)", () => {
    // Principal has both /p/a.txt and /p/b.txt; request restricts to /p/a.txt only.
    const result = serverEffectiveCapabilities(
      serverCtx({
        principalPolicy: set(
          { kind: "commit-file", path: "/p/a.txt" },
          { kind: "commit-file", path: "/p/b.txt" },
        ),
        requestRestriction: set({ kind: "commit-file", path: "/p/a.txt" }),
      }),
    );
    expect(result.capabilities.capabilities).toHaveLength(1);
    expect(result.capabilities.capabilities[0]).toMatchObject({ path: "/p/a.txt" });
  });

  it("omitted request restriction uses principal baseline (NOT whole ceiling)", () => {
    // Deployment ceiling is broad; principal is narrow. Omitting request
    // restriction does NOT give the caller the ceiling.
    const result = serverEffectiveCapabilities(
      serverCtx({
        deploymentCeiling: set(
          { kind: "commit-file", path: "/p/a.txt" },
          { kind: "commit-file", path: "/p/b.txt" },
          { kind: "commit-file", path: "/p/c.txt" },
        ),
        principalPolicy: set({ kind: "commit-file", path: "/p/a.txt" }),
      }),
    );
    expect(result.capabilities.capabilities).toHaveLength(1);
  });

  it("serverCapabilityCovers checks structural equality", () => {
    const eff = set({ kind: "commit-file", path: "/p/a.txt" });
    expect(
      serverCapabilityCovers(eff, { kind: "commit-file", path: "/p/a.txt" }),
    ).toBe(true);
    expect(
      serverCapabilityCovers(eff, { kind: "commit-file", path: "/p/b.txt" }),
    ).toBe(false);
  });
});

describe("PendingApprovalStore (T407/T408, QS-4.5)", () => {
  function req(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
    return {
      requestId: "r1",
      principalId: "user-1",
      runId: "run-1",
      sessionId: "sess-1",
      toolCallId: "c1",
      actionDigest: "d1",
      action: { title: "t", summary: "s", canonicalTargets: [], effects: [] },
      requestedCapabilities: [{ kind: "commit-file", path: "/p/a.txt" }],
      approvalOptions: [],
      approvalChoices: [],
      offeredLifetimes: ["action"],
      createdAt: 0,
      expiresAt: Date.now() + 60_000,
      ...overrides,
    };
  }

  it("create is idempotent on requestId", () => {
    const store = new PendingApprovalStore();
    const a = store.create({
      request: req(),
      tenantId: "t-1",
      sessionId: "sess-1",
      continuationId: "cont-1",
    });
    const b = store.create({
      request: req(),
      tenantId: "t-1",
      sessionId: "sess-1",
      continuationId: "cont-2",
    });
    expect(a.continuationId).toBe(b.continuationId); // same record returned
  });

  it("CAS permits exactly one terminal transition; duplicates rejected", () => {
    const store = new PendingApprovalStore();
    const rec = store.create({
      request: req(),
      tenantId: "t-1",
      sessionId: "sess-1",
      continuationId: "cont-1",
    });
    const decision = {
      approved: true,
      requestId: "r1",
      actionDigest: "d1",
      optionId: "opt-1",
      lifetime: "action" as const,
      actorId: "u",
      decidedAt: Date.now(),
    };
    const first = store.cas("cont-1", rec.version, decision);
    const second = store.cas("cont-1", rec.version, decision);
    expect(first.status).toBe("transitioned");
    expect(second.status).toBe("duplicate");
  });

  it("stale version rejected", () => {
    const store = new PendingApprovalStore();
    store.create({
      request: req(),
      tenantId: "t-1",
      sessionId: "sess-1",
      continuationId: "cont-1",
    });
    const decision = {
      approved: true,
      requestId: "r1",
      actionDigest: "d1",
      optionId: "opt-1",
      lifetime: "action" as const,
      actorId: "u",
      decidedAt: 0,
    };
    expect(store.cas("cont-1", 999, decision).status).toBe("stale");
  });

  it("expired request denies safely", () => {
    const store = new PendingApprovalStore();
    const expired = req({ expiresAt: 1 });
    store.create({
      request: expired,
      tenantId: "t-1",
      sessionId: "sess-1",
      continuationId: "cont-1",
    });
    const decision = {
      approved: true,
      requestId: "r1",
      actionDigest: "d1",
      optionId: "opt-1",
      lifetime: "action" as const,
      actorId: "u",
      decidedAt: 0,
    };
    expect(store.cas("cont-1", 1, decision, Date.now() + 10_000).status).toBe("expired");
  });

  it("listPending returns only pending records for the principal/session", () => {
    const store = new PendingApprovalStore();
    store.create({ request: req(), tenantId: "t-1", sessionId: "s-1", continuationId: "c-1" });
    store.create({
      request: req({ requestId: "r2", principalId: "user-2" }),
      tenantId: "t-1",
      sessionId: "s-1",
      continuationId: "c-2",
    });
    const pending = store.listPending("user-1");
    expect(pending).toHaveLength(1);
    expect(pending[0].request.principalId).toBe("user-1");
  });

  it("reevaluate flips an approved record to denied when ceiling revoked", () => {
    const store = new PendingApprovalStore();
    const rec = store.create({
      request: req(),
      tenantId: "t-1",
      sessionId: "s-1",
      continuationId: "c-1",
    });
    store.cas("c-1", rec.version, {
      approved: true,
      requestId: "r1",
      actionDigest: "d1",
      optionId: "opt-1",
      lifetime: "action",
      actorId: "u",
      decidedAt: 0,
    });
    // Simulate a revoked ceiling: covers() now returns false.
    store.reevaluate("c-1", () => false);
    const after = store.get("c-1");
    expect(after?.state).toBe("denied");
  });

  it("cancel moves a pending record to cancelled", () => {
    const store = new PendingApprovalStore();
    store.create({ request: req(), tenantId: "t-1", sessionId: "s-1", continuationId: "c-1" });
    store.cancel("c-1");
    expect(store.get("c-1")?.state).toBe("cancelled");
  });
});
