/**
 * WS approval-decision conformance (spec 011, T022 review fix).
 *
 * An approved WebSocket response must bind to the request's narrowest
 * policy-issued option; a request with no representable option can only be
 * denied — and the caller must let execution follow the validated decision
 * so the durable record and the executed outcome never disagree.
 */
import { describe, it, expect } from "vitest";
import { wsApprovalDecision, wsLegacyApprovalRequest } from "../ws-handlers.js";
import type { PermissionRequest } from "../../../foundations/contracts/permission-policy.js";

function requestWithOptions(): PermissionRequest {
  return {
    requestId: "c-1",
    principalId: "u",
    runId: "r",
    toolCallId: "c-1",
    actionDigest: "d-1",
    action: { title: "t", summary: "s", canonicalTargets: [], effects: [] },
    requestedCapabilities: [],
    approvalOptions: [
      {
        optionId: "opt-exact",
        actionDigest: "d-1",
        kind: "exact",
        label: "Exact",
        capabilities: [],
        supportedLifetimes: ["action"],
      },
    ],
    approvalChoices: [
      {
        choiceId: "opt-exact::action",
        optionId: "opt-exact",
        lifetime: "action",
        title: "Allow this action once",
        description: "You'll be asked again next time.",
        authoritySummary: [],
        recommended: true,
      },
    ],
    offeredLifetimes: ["action"],
    createdAt: 0,
    expiresAt: Date.now() + 60_000,
  };
}

describe("wsApprovalDecision (T022)", () => {
  it("binds an approved response to the request's narrowest option", () => {
    const decision = wsApprovalDecision(
      { type: "tool_approval_response", callId: "c-1", name: "write_file", approved: true },
      requestWithOptions(),
      0,
    );
    expect(decision.approved).toBe(true);
    if (decision.approved) {
      expect(decision.optionId).toBe("opt-exact");
      expect(decision.lifetime).toBe("action");
      expect(decision.requestId).toBe("c-1");
    }
  });

  it("denies an approved response when the request has no options — and execution must follow", () => {
    const request = requestWithOptions();
    request.approvalOptions = [];
    const decision = wsApprovalDecision(
      { type: "tool_approval_response", callId: "c-1", name: "write_file", approved: true },
      request,
      0,
    );
    expect(decision.approved).toBe(false);
    if (!decision.approved) {
      expect(decision.reason).toContain("approval-unavailable");
    }
    // The resolved callback must use decision.approved (false here), never
    // the raw msg.approved — otherwise the tool would run while the durable
    // record says denied.
    expect(decision.approved).toBe(false);
  });

  it("keeps a plain denial as a denial", () => {
    const decision = wsApprovalDecision(
      { type: "tool_approval_response", callId: "c-1", name: "write_file", approved: false },
      requestWithOptions(),
      0,
    );
    expect(decision.approved).toBe(false);
    expect(decision.requestId).toBe("c-1");
  });

  it("production WS requests carry a representable exact option, so approvals can succeed (review fix)", () => {
    // The production request constructor must never produce an option-less
    // request: that would silently turn every client approval into
    // approval-unavailable (record/execution would agree, but the WS
    // approval surface would be dead).
    const request = wsLegacyApprovalRequest("call-9", "write_file", 0);
    expect(request.approvalOptions.length).toBe(1);
    expect(request.approvalOptions[0].kind).toBe("exact");
    expect(request.approvalOptions[0].actionDigest).toBe("call-9");
    // No authority is invented: the legacy surface's own loop remains the
    // authority, the option only makes the approval representable.
    expect(request.approvalOptions[0].capabilities).toEqual([]);

    const decision = wsApprovalDecision(
      { type: "tool_approval_response", callId: "call-9", name: "write_file", approved: true },
      request,
      0,
    );
    expect(decision.approved).toBe(true);
    if (decision.approved) {
      expect(decision.optionId).toBe("ws-exact-call-9");
    }
  });
});
