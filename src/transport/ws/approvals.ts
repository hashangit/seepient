/**
 * WebSocket Tool Approval Lifecycle Handlers
 */

import * as crypto from "node:crypto";
import type { WebSocket, ToolApprovalResponse } from "./ws-types.js";
import type {
  PermissionDecision,
  PermissionRequest,
} from "../../foundations/contracts/permission-policy.js";
import type { ApproveToolFn } from "../../foundations/types.js";
import { safeSend, pendingApprovals, durableApprovalStore } from "./connection-registry.js";

export const APPROVAL_TIMEOUT_MS = 30_000; // 30 seconds

/**
 * Build the durable-store request record for the WS legacy surface (spec 011
 * T022 review fix). The legacy server loop has no Domain policy evaluation on
 * this path, so the record carries ONE exact-for-this-call option: its
 * capabilities are empty (no authority is invented — the legacy loop remains
 * the sole authority) and the option only makes the approval representable so
 * the durable record and the executed outcome stay consistent. When the P4
 * server split wires the real pipeline, engine-issued options replace this.
 */
export function wsLegacyApprovalRequest(
  callId: string,
  callName: string,
  now = Date.now(),
): PermissionRequest {
  return {
    requestId: callId,
    principalId: "ws-user",
    runId: "ws-run",
    toolCallId: callId,
    actionDigest: callId,
    action: { title: callName, summary: callName, canonicalTargets: [], effects: [] },
    requestedCapabilities: [],
    approvalOptions: [
      {
        optionId: `ws-exact-${callId}`,
        actionDigest: callId,
        kind: "exact",
        label: `Only this call — ${callName} (legacy server surface)`,
        capabilities: [],
        supportedLifetimes: ["action"],
      },
    ],
    approvalChoices: [
      {
        choiceId: `ws-exact-${callId}::action`,
        optionId: `ws-exact-${callId}`,
        lifetime: "action",
        title: "Allow this action once",
        description: "You'll be asked again next time.",
        authoritySummary: [`Approve the tool call shown (${callName})`],
        recommended: true,
      },
    ],
    offeredLifetimes: ["action"],
    createdAt: now,
    expiresAt: now + APPROVAL_TIMEOUT_MS,
  };
}

/**
 * Create an `approveTool` callback for the server adapter.
 * Sends a `tool_approval_request` to the client and waits for a
 * `tool_approval_response`. Falls back to auto-deny on timeout.
 */
export function createServerApproveTool(ws: WebSocket): ApproveToolFn {
  return async (call) => {
    const callId = crypto.randomUUID();
    const continuationId = `cont-${callId}`;

    durableApprovalStore.create({
      request: wsLegacyApprovalRequest(callId, call.name),
      tenantId: "default",
      sessionId: "ws-session",
      continuationId,
    });

    safeSend(ws, {
      type: "tool_approval_request",
      callId,
      name: call.name,
      args: call.args,
    });

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        durableApprovalStore.cancel(continuationId);
        pendingApprovals.delete(callId);
        resolve(false); // Timeout → deny
      }, APPROVAL_TIMEOUT_MS);

      pendingApprovals.set(callId, { continuationId, resolve, timer, ws, toolName: call.name, createdAt: Date.now() });
    });
  };
}

export async function handleToolApprovalResponse(
  ws: WebSocket,
  msg: ToolApprovalResponse,
): Promise<void> {
  const pending = pendingApprovals.get(msg.callId);
  if (!pending) return;

  // QA-001: Only the originating connection may resolve the approval
  if (pending.ws !== ws) return;

  // Defense-in-depth: verify the tool name matches the pending request
  if (msg.name !== pending.toolName) return;

  // Reject expired approvals (defense-in-depth, timer should have fired)
  if (Date.now() - pending.createdAt > APPROVAL_TIMEOUT_MS) {
    clearTimeout(pending.timer);
    pendingApprovals.delete(msg.callId);
    durableApprovalStore.cancel(pending.continuationId);
    pending.resolve(false);
    return;
  }

  // Spec 011 (T022): an approved legacy response must bind to the request's
  // narrowest policy-issued option; with no options the approval cannot be
  // represented and is denied as unavailable.
  const rec = durableApprovalStore.get(pending.continuationId);
  const decision = wsApprovalDecision(msg, rec?.request);

  const result = await durableApprovalStore.cas(pending.continuationId, 1, decision);
  clearTimeout(pending.timer);
  pendingApprovals.delete(msg.callId);

  // Execution MUST follow the validated typed decision: when the request had
  // no representable policy option, the approval was persisted as denied and
  // the tool must NOT run (spec 011 review fix). The durable record and the
  // resolved callback never disagree.
  if (result.status === "transitioned") {
    pending.resolve(decision.approved);
  } else {
    pending.resolve(false);
  }
}

/**
 * Build the strict typed decision for a WS approval response (spec 011
 * T022). An approved response is bound to the request's narrowest
 * policy-issued option; a request with no representable option can only be
 * denied as `approval-unavailable`, and the caller must let execution follow
 * this decision. Pure and exported for conformance tests.
 */
export function wsApprovalDecision(
  msg: ToolApprovalResponse,
  request: PermissionRequest | undefined,
  now = Date.now(),
): PermissionDecision {
  const option = request?.approvalOptions[0];
  if (msg.approved && option) {
    return {
      approved: true,
      requestId: msg.callId,
      actionDigest: msg.callId,
      optionId: option.optionId,
      lifetime: "action",
      actorId: "ws-user",
      decidedAt: now,
    };
  }
  return {
    approved: false,
    requestId: msg.callId,
    actionDigest: msg.callId,
    actorId: "ws-user",
    reason: msg.approved
      ? "approval-unavailable: request has no representable option"
      : undefined,
    decidedAt: now,
  };
}
