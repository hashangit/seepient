/**
 * Resolve-once pin (022-5-WO2 T015): a duplicate tool_approval_response in
 * the persist window must not flip an already-approved call to false. The
 * CAS returns "duplicate" with the approved record — the handler resolves
 * idempotently instead of denying.
 */
import { describe, it, expect, vi } from "vitest";
import { createServerApproveTool, handleToolApprovalResponse } from "../approvals.js";
import { createConnectionRegistry } from "../connection-registry.js";
import type { ToolApprovalResponse } from "../ws-types.js";

function fakeWs() {
  return { send: vi.fn() } as never;
}

describe("duplicate approval responses (022-5-WO2 T015)", () => {
  it("a second response in the persist window does not flip the resolved approval", async () => {
    const registry = createConnectionRegistry({ inMemory: true });
    const ws = fakeWs();
    const approveTool = createServerApproveTool(ws, registry, {
      principalId: "sha256:test",
      tenantId: "t1",
      sessionId: "s1",
      runId: "r1",
    });

    const pending = approveTool({ name: "read_file", args: { path: "a.txt" } });
    await new Promise((r) => setTimeout(r, 5));
    const callId = [...registry.pendingApprovals.keys()][0];
    expect(callId).toBeDefined();

    const raced = Promise.race([pending, new Promise<boolean>((r) => setTimeout(() => r(false), 2000))]);
    const msg = {
      type: "tool_approval_response",
      callId,
      name: "read_file",
      approved: true,
    } as ToolApprovalResponse;
    // Two responses "simultaneously" — both enter before the pending entry
    // is deleted (the persist window).
    await Promise.allSettled([handleToolApprovalResponse(ws, msg, registry), handleToolApprovalResponse(ws, msg, registry)]);

    const result = await raced;
    expect(result).toBe(true);
  });
});
