/**
 * US0 red gate (022-5-WO1 T002): the WS consent plane must work for an
 * AUTHENTICATED tenant. chat.ts stamps the record with the connection's
 * apiKeyHash principal; the approval decision must carry the same principal
 * as actorId, or the principal-bound CAS (022-5 FR-013) rejects every
 * legitimate approval as stale and the user's "Approve" silently does
 * nothing. Product contract: clicking Approve approves.
 */
import { describe, it, expect, vi } from "vitest";
import { WebSocket } from "ws";
import { createServerApproveTool, handleToolApprovalResponse } from "../approvals.js";
import { createConnectionRegistry } from "../connection-registry.js";
import type { ToolApprovalResponse } from "../ws-types.js";

function fakeWs(): WebSocket {
  return { send: vi.fn() } as unknown as WebSocket;
}

describe("WS multi-approval with an authenticated principal (022-5-WO1 T002)", () => {
  it("an approved response resolves true when the connection is authenticated", async () => {
    const registry = createConnectionRegistry({ inMemory: true });
    const ws = fakeWs();
    const approveTool = createServerApproveTool(ws, registry, {
      principalId: "sha256:test",
      tenantId: "t1",
      sessionId: "s1",
      runId: "r1",
    });

    const pending = approveTool({ name: "read_file", args: { path: "a.txt" } });
    // Let the create() persist land, then answer from the same connection.
    await new Promise((r) => setTimeout(r, 5));

    const callId = [...registry.pendingApprovals.keys()][0];
    expect(callId).toBeDefined();

    const resolvePromise = Promise.race([pending, new Promise<boolean>((r) => setTimeout(() => r(false), 2000))]);
    await handleToolApprovalResponse(ws, {
      type: "tool_approval_response",
      callId,
      name: "read_file",
      approved: true,
    } as ToolApprovalResponse, registry);

    const result = await resolvePromise;
    expect(result).toBe(true);
  });
});
