/**
 * Native bridge wiring through use-agent (spec 011, T010, FR-017).
 *
 * Proves the hook installs the typed broker before chat, exposes the full
 * PermissionRequest as pending permission state, resolves a transient
 * TuiApprovalSelection back through the broker, and clears the seam on chat
 * completion and unmount. The legacy (flag-off) path still flows raw tool
 * name/arguments through the legacy approveTool.
 */
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import React, { useEffect } from "react";
import { useAgent, type AgentApi } from "../hooks/use-agent.js";
import type { FeedApi } from "../hooks/use-feed.js";
import type { Agent } from "../../../transport/cli/agent.js";
import type {
  ApprovalBroker,
  PermissionRequest,
  TuiApprovalSelection,
} from "../../../foundations/contracts/permission-policy.js";

const feed: FeedApi = {
  entries: [],
  appendEntry: () => "e1",
  updateEntry: () => {},
  clear: () => {},
  updateBlockEntry: () => {},
};

const tick = (): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

/** Poll until the condition holds; robust under parallel-suite load. */
async function waitFor(cond: () => boolean, what: string): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > 3000) {
      throw new Error(`waitFor timeout: ${what}`);
    }
    await tick();
  }
}

function fakeRequest(): PermissionRequest {
  return {
    requestId: "req-hook",
    principalId: "u",
    runId: "r1",
    sessionId: "sess-1",
    toolCallId: "c1",
    actionDigest: "ad-1",
    action: { title: "Write file", summary: "Write file", canonicalTargets: [], effects: ["filesystem-write"] },
    requestedCapabilities: [{ kind: "commit-file", path: "/p/a.txt" }],
    approvalOptions: [
      {
        optionId: "opt-1",
        actionDigest: "ad-1",
        kind: "exact",
        label: "Exact — write /p/a.txt",
        capabilities: [{ kind: "commit-file", path: "/p/a.txt" }],
        supportedLifetimes: ["action", "session"],
      },
    ],
    offeredLifetimes: ["action", "session"],
    createdAt: 0,
    expiresAt: Date.now() + 60_000,
  };
}

interface FakeAgent extends Agent {
  getInstalledBroker(): ApprovalBroker | undefined;
  clearCount(): number;
}

function fakePipelineAgent(): FakeAgent {
  let installed: ApprovalBroker | undefined;
  let clears = 0;
  const agent = {
    createAbortSignal: () => new AbortController().signal,
    isPermissionPipelineEnabled: () => true,
    setPipelineApprovalBroker: (b?: ApprovalBroker) => {
      installed = b;
      if (b === undefined) clears++;
    },
    abort: () => {},
    chat: async (
      _input: string,
      signal?: AbortSignal,
      _approveTool?: unknown,
      _permissionLevel?: unknown,
      onStep?: (step: { type: string; content?: string; toolCall?: unknown }) => void,
    ) => {
      // The agent loop consults the INSTALLED broker for needs-approval.
      const decision = await installed!.request(fakeRequest(), { signal });
      onStep?.({
        type: "tool_call",
        content: "",
        toolCall: {
          id: "t1",
          name: "write_file",
          args: {},
          result: decision.approved ? "ok" : "denied",
          duration: 0,
        },
      });
      return {
        finishReason: "success",
        usage: { promptTokens: 1, completionTokens: 1, cost: 0 },
      };
    },
  } as unknown as Agent;
  return Object.assign(agent, {
    getInstalledBroker: () => installed,
    clearCount: () => clears,
  }) as unknown as FakeAgent;
}

function fakeLegacyAgent(): FakeAgent {
  let clears = 0;
  const agent = {
    createAbortSignal: () => new AbortController().signal,
    isPermissionPipelineEnabled: () => false,
    setPipelineApprovalBroker: (b?: ApprovalBroker) => {
      if (b === undefined) clears++;
    },
    abort: () => {},
    chat: async (
      _input: string,
      _signal?: AbortSignal,
      approveTool?: (call: { name: string; args: Record<string, unknown> }) => Promise<unknown>,
    ) => {
      const decision = await approveTool!({ name: "write_file", args: { path: "/p/a.txt" } });
      return {
        finishReason: "success",
        usage: { promptTokens: 1, completionTokens: 1, cost: 0 },
        legacyDecision: decision,
      };
    },
  } as unknown as Agent;
  return Object.assign(agent, {
    getInstalledBroker: () => undefined,
    clearCount: () => clears,
  }) as unknown as FakeAgent;
}

function mountHook(agent: Agent): { api: () => AgentApi | null; unmount: () => void } {
  const box: { current: AgentApi | null } = { current: null };
  function Harness() {
    const api = useAgent({ agent, feed });
    useEffect(() => {
      box.current = api;
    });
    return null;
  }
  const r = render(React.createElement(Harness));
  return { api: () => box.current, unmount: () => r.unmount() };
}

function fakeAbortingAgent(): FakeAgent {
  let installed: ApprovalBroker | undefined;
  let clears = 0;
  const agent = {
    createAbortSignal: () => new AbortController().signal,
    isPermissionPipelineEnabled: () => true,
    setPipelineApprovalBroker: (b?: ApprovalBroker) => {
      installed = b;
      if (b === undefined) clears++;
    },
    abort: () => {},
    chat: async (_input: string) => {
      // Simulate an approval aborted mid-prompt (deadline / cancel): the
      // broker composes this signal and the presenter must settle the
      // pending prompt instead of hanging.
      const controller = new AbortController();
      const pending = installed!.request(fakeRequest(), { signal: controller.signal });
      setTimeout(() => controller.abort(), 10);
      const decision = await pending;
      return {
        finishReason: "success",
        usage: { promptTokens: 1, completionTokens: 1, cost: 0 },
        decision,
      };
    },
  } as unknown as Agent;
  return Object.assign(agent, {
    getInstalledBroker: () => installed,
    clearCount: () => clears,
  }) as unknown as FakeAgent;
}

describe("use-agent native bridge (T010)", () => {
  it("installs the typed broker, holds the request, and resolves a selection", async () => {
    const agent = fakePipelineAgent();
    const { api, unmount } = mountHook(agent as unknown as Agent);
    await tick();

    const submitPromise = api()!.submit("write the file");
    // The full typed request becomes pending in UI state.
    await waitFor(() => api()!.pendingPermission !== null, "pending permission set");
    const pending = api()!.pendingPermission;
    if (pending === null) return; // unreachable; satisfies TS narrowing
    expect(pending.kind).toBe("native");
    if (pending.kind === "native") {
      expect(pending.request.requestId).toBe("req-hook");
      expect(pending.request.approvalOptions.length).toBeGreaterThan(0);
    }
    // The broker is installed while the prompt is visible.
    expect(agent.getInstalledBroker()).toBeDefined();

    // The user submits a transient selection; the broker enriches it.
    const selection: TuiApprovalSelection = { approved: true, optionId: "opt-1", lifetime: "action" };
    api()!.resolvePermission(selection);
    await submitPromise;
    await waitFor(() => api()!.pendingPermission === null, "pending cleared");

    expect(api()!.pendingPermission).toBeNull();
    // The seam is cleared when the chat completes.
    expect(agent.clearCount()).toBeGreaterThan(0);
    unmount();
  });

  it("resolves a denial on abort and clears the seam on unmount", async () => {
    const agent = fakePipelineAgent();
    const { api, unmount } = mountHook(agent as unknown as Agent);
    await tick();

    const submitPromise = api()!.submit("write the file");
    await waitFor(() => api()!.pendingPermission !== null, "pending permission set");
    expect(api()!.pendingPermission!.kind).toBe("native");

    api()!.abort();
    await submitPromise;
    await waitFor(() => api()!.pendingPermission === null, "pending cleared");
    expect(api()!.pendingPermission).toBeNull();

    const clearsBefore = agent.clearCount();
    unmount();
    expect(agent.clearCount()).toBeGreaterThan(clearsBefore);
  });

  it("an aborted broker request settles the pending prompt as a typed denial (review fix)", async () => {
    const agent = fakeAbortingAgent();
    const { api, unmount } = mountHook(agent as unknown as Agent);
    await tick();

    const submitPromise = api()!.submit("write the file");
    await waitFor(() => api()!.pendingPermission !== null, "pending permission set");

    // Nobody approves and nobody denies: the abort must settle everything.
    await submitPromise;
    await waitFor(() => api()!.pendingPermission === null, "pending cleared on abort");
    expect(api()!.pendingPermission).toBeNull();
    unmount();
  });

  it("legacy (flag-off) path keeps raw tool name/arguments and legacy decisions", async () => {
    const agent = fakeLegacyAgent();
    const { api, unmount } = mountHook(agent as unknown as Agent);
    await tick();

    const submitPromise = api()!.submit("write the file");
    await waitFor(() => api()!.pendingPermission !== null, "pending permission set");

    const pending = api()!.pendingPermission;
    if (pending === null) return; // unreachable; satisfies TS narrowing
    expect(pending.kind).toBe("legacy");
    if (pending.kind === "legacy") {
      expect(pending.view.toolName).toBe("write_file");
      expect(pending.view.args).toEqual({ path: "/p/a.txt" });
    }

    // Legacy deny: plain boolean.
    api()!.resolvePermission(false);
    await submitPromise;
    await waitFor(() => api()!.pendingPermission === null, "pending cleared");
    expect(api()!.pendingPermission).toBeNull();
    unmount();
  });
});
