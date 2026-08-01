/**
 * P4 REST resumable-approval tests (spec 008, T406, QS-4.4).
 *
 * Verifies: interaction:"never" → immediate denial + model adapts;
 * interaction:"resumable" → returns approval_required + continuation ID;
 * resume reevaluates ceilings before dispatch; revoked ceiling denies.
 */
import { describe, it, expect } from "vitest";
import {
  handleNeedsApproval,
  resumeContinuation,
} from "../resumable-approval.js";
import type { PermissionRequest } from "../../../foundations/contracts/permission-policy.js";

function req(): PermissionRequest {
  return {
    requestId: "r1",
    principalId: "u",
    runId: "r",
    sessionId: "s",
    toolCallId: "c1",
    actionDigest: "d1",
    action: { title: "t", summary: "s", canonicalTargets: [], effects: [] },
    requestedCapabilities: [{ kind: "commit-file", path: "/p/a.txt" }],
    approvalOptions: [],
    offeredLifetimes: ["action"],
    createdAt: 0,
    expiresAt: Date.now() + 60_000,
  };
}

describe("REST resumable-approval (T406, QS-4.4)", () => {
  it("interaction:never → immediate denial, never waits", () => {
    const res = handleNeedsApproval({
      interaction: "never",
      request: req(),
      continuationId: "c-1",
    });
    expect(res.status).toBe("denied");
    if (res.status === "denied") expect(res.reason).toBe("approval-unavailable");
  });

  it("interaction:resumable → returns approval_required + continuationId", () => {
    let persisted: { continuationId: string } | undefined;
    const res = handleNeedsApproval({
      interaction: "resumable",
      request: req(),
      continuationId: "c-1",
      persist: (rec) => (persisted = rec),
    });
    expect(res.status).toBe("approval_required");
    if (res.status === "approval_required") {
      expect(res.continuationId).toBe("c-1");
      expect(persisted?.continuationId).toBe("c-1");
    }
  });

  it("resume reevaluates ceiling — revoked ceiling denies", () => {
    const request = req();
    const decision = {
      approved: true,
      requestId: "r1",
      actionDigest: "d1",
      optionId: "opt-1",
      lifetime: "action" as const,
      actorId: "u",
      decidedAt: 0,
    };
    const result = resumeContinuation({
      continuationId: "c-1",
      decision,
      coversNow: () => false, // ceiling revoked
      lookup: () => ({ request }),
    });
    expect(result.proceed).toBe(false);
    if (!result.proceed) expect(result.reason).toBe("outside-ceiling");
  });

  it("resume proceeds when ceiling still covers the request", () => {
    const request = req();
    const decision = {
      approved: true,
      requestId: "r1",
      actionDigest: "d1",
      optionId: "opt-1",
      lifetime: "action" as const,
      actorId: "u",
      decidedAt: 0,
    };
    const result = resumeContinuation({
      continuationId: "c-1",
      decision,
      coversNow: () => true,
      lookup: () => ({ request }),
    });
    expect(result.proceed).toBe(true);
  });

  it("resume rejects a decision for a different action digest", () => {
    const request = req();
    const decision = {
      approved: true,
      requestId: "r1",
      actionDigest: "different",
      optionId: "opt-1",
      lifetime: "action" as const,
      actorId: "u",
      decidedAt: 0,
    };
    const result = resumeContinuation({
      continuationId: "c-1",
      decision,
      coversNow: () => true,
      lookup: () => ({ request }),
    });
    expect(result.proceed).toBe(false);
  });

  it("resume of unknown continuation denies", () => {
    const decision = {
      approved: true,
      requestId: "r1",
      actionDigest: "d1",
      optionId: "opt-1",
      lifetime: "action" as const,
      actorId: "u",
      decidedAt: 0,
    };
    const result = resumeContinuation({
      continuationId: "missing",
      decision,
      coversNow: () => true,
      lookup: () => undefined,
    });
    expect(result.proceed).toBe(false);
  });
});
