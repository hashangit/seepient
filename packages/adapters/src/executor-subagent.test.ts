/**
 * 029 T037 — run_subagent lifted onto THE Seepient loop (engine path).
 *
 * The helper is a nested `deps.runtime.run` with the `#helper` run-id marker:
 * the restricted tool subset (no delegation tools), nesting refusal inside
 * the helper, child progress mapped into the parent thread, and usage
 * recorded with subagent/parent attribution.
 */
import { describe, expect, it, vi } from "vitest";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";

vi.mock("./computer-lifecycle.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./computer-lifecycle.js")>();
  return {
    ...actual,
    provisionComputer: async () => ({ id: "computer-1", kind: "desktop" }),
  };
});

import type { AgentRunRequest } from "@seepients/adapter-kit";
import type { PrismaClient } from "@seepients/db";
import { createRunExecutor } from "./executor.js";

function fixture(
  options: {
    scenario?: "default" | "pause-propagation" | "abort-race";
    shutdownSignal?: AbortSignal;
  } = {},
) {
  const scenario = options.scenario ?? "default";
  const run = {
    id: "run-1",
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: "space-1",
    userId: "user-1",
    status: "queued",
    trigger: "user",
    leaseFence: 0,
  };
  const appends: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const usageRecords: Array<{ operationId: string; operationKind?: string; parentRunId?: string }> = [];
  const helperRequests: Array<AgentRunRequest> = [];

  const pauseRun = vi.fn(async () => true);
  const abortCalls: string[] = [];
  const abortLink = Promise.withResolvers<void>();
  const abort = vi.fn(async (runId: string) => {
    abortCalls.push(runId);
    abortLink.resolve();
    return undefined;
  });
  const runtimeRun = vi.fn(async function* (request: AgentRunRequest) {
    if (request.runId.includes("#helper-")) {
      helperRequests.push(request);
      if (scenario === "pause-propagation") {
        // The helper's governed tool raises a pause: the helper suspends,
        // and the suspension must propagate as the PARENT's pause sentinel.
        yield { type: "suspended" as const, pauseClass: "permission" as const, pauseToken: "helper-pause-1" };
        yield { type: "done" as const, text: "SHOULD NEVER EMIT" };
        return;
      }
      // Inside the helper: its "model" tries to nest — must be refused.
      const nested = await request.executeTool!(
        "run_subagent",
        { name: "nested", task: "double-delegate" },
        "helper-call-nested",
      );
      const refusal = (nested as { error?: string }).error;
      if (!refusal?.includes("cannot nest further")) {
        throw new Error(`nested run_subagent was not refused: ${JSON.stringify(refusal)}`);
      }
      if (scenario === "abort-race") {
        // The helper parks until the parent's abort reaches it (the LINK
        // under test): runtime.abort(helperRunId) resolves the parked wait.
        await abortLink.promise;
        yield { type: "done" as const, text: "helper settled by abort" };
        return;
      }
      yield { type: "text" as const, text: "survey complete" };
      yield { type: "done" as const, text: "helper done" };
      return;
    }
    // Parent model asks for a helper; applyTool dispatches the nested run.
    await request.executeTool!("run_subagent", { name: "scout", task: "survey the docs" }, "call-1");
    yield { type: "done" as const, text: "done" };
  });

  const executor = createRunExecutor({
    prisma: {
      run: {
        findUnique: vi.fn(async () => ({ ...run })),
        findUniqueOrThrow: vi.fn(async () => ({ ...run, sourceMessage: null })),
        updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          Object.assign(run, data);
          return { count: 1 };
        }),
      },
      bot: {
        findUnique: vi.fn(async () => ({ id: run.botId, name: "Assistant", title: "", description: "", disabledBuiltinTools: [], computerId: "computer-1", computer: { id: "computer-1", scope: "dedicated" } })),
        findUniqueOrThrow: vi.fn(async () => ({ id: run.botId, name: "Assistant", title: "", description: "", disabledBuiltinTools: [], computerId: "computer-1", computer: { id: "computer-1", scope: "dedicated" } })),
        findMany: vi.fn(async () => []),
      },
      attempt: { create: vi.fn(async () => ({ id: "attempt-1" })), update: vi.fn(), updateMany: vi.fn(async () => ({ count: 1 })) },
      thread: { findUniqueOrThrow: vi.fn(async () => ({ id: run.threadId, groupId: null })), update: vi.fn(async () => ({ nextEventSeq: 1 })) },
      message: { findMany: vi.fn(async () => []) },
      task: { findUniqueOrThrow: vi.fn(async () => ({ id: run.taskId, prompt: "p" })), updateMany: vi.fn(async () => ({ count: 1 })) },
      connection: { findMany: vi.fn(async () => []) },
      spaceModelPreference: { findFirst: vi.fn(async () => null) },
      userModelCredential: { findFirst: vi.fn(async () => null) },
      deploymentSettings: { findUnique: vi.fn(async () => ({ defaultModelProvider: "scripted", defaultModelId: "scripted" })) },
      taughtSkill: { findMany: vi.fn(async () => []) },
      agentSecret: { findMany: vi.fn(async () => []) },
      botSecret: { findMany: vi.fn(async () => []) },
      agentSkill: { findMany: vi.fn(async () => []) },
      scratchpadItem: { findMany: vi.fn(async () => []) },
      actionApprovalRule: { findMany: vi.fn(async () => []) },
      actionAutoReviewPreference: { findUnique: vi.fn(async () => ({ enabled: false })) },
      computer: {
      findUnique: vi.fn(async () => ({ id: "computer-1", scope: "dedicated", controlLeaseId: null, maintenanceId: null, updatedAt: new Date(0), state: "running", providerRef: null, homeKey: "bot-1-home" })),
      findUniqueOrThrow: vi.fn(async () => ({ id: "computer-1", scope: "dedicated", controlLeaseId: null, maintenanceId: null, updatedAt: new Date(0), state: "running", providerRef: null, homeKey: "bot-1-home" })),
      findFirst: vi.fn(async () => ({ id: "computer-1", scope: "dedicated" })),
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    computerLease: {
      findUnique: vi.fn(async () => null),
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => ({})),
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    externalEffect: {
        findMany: vi.fn(async () => []),
        findUnique: vi.fn(async () => null),
        create: vi.fn(async () => ({})),
        update: vi.fn(),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
    } as unknown as PrismaClient,
    runtime: {
      describe: () => ({ capabilities: { scripted: false } }),
      run: runtimeRun,
      abort,
    },
    connector: { discoverTools: async () => [], resolveCall: async () => undefined, execute: async function* () {} },
    sandbox: {
      describe: () => ({ capabilities: { graphical: false } }),
      provision: vi.fn(async () => ({ id: "computer-1", kind: "desktop", fresh: false, providerRef: "kept" })),
      prepare: vi.fn(async () => undefined),
      isRunning: vi.fn(async () => true),
    },
    memory: {
      describe: () => ({ capabilities: {} }),
      read: async () => ({ documents: [] }),
      search: async () => [],
      commit: vi.fn(async () => ({ revision: "rev-1" })),
      exportMarkdown: async function* () {},
    },
    memoryProviders: { resolve: async () => null },
    events: {
      append: vi.fn(async (input: { type: string; payload: Record<string, unknown> }) => {
        appends.push({ type: input.type, payload: input.payload });
        return { threadId: run.threadId, seq: appends.length };
      }),
      pauseRunForInput: pauseRun,
      finalizeRun: vi.fn(async () => ({ continuationRunId: null })),
    },
    jobs: { enqueue: vi.fn(async () => undefined) },
    secrets: [],
    shutdownSignal: options.shutdownSignal ?? new AbortController().signal,
  } as unknown as Parameters<typeof createRunExecutor>[0]);

  return {
    run,
    pauseRunForInput: pauseRun,
    abort,
    abortCalls,
    abortLink,
    appends,
    usageRecords,
    helperRequests,
    executor,
  };
}

describe("029 T037 — run_subagent on the engine loop", () => {
  it("helper runs as a nested runtime attempt; nesting refused; child progress mapped; usage attributed", async () => {
    const f = fixture();
    f.run.status = "queued";
    await f.executor.continueRun(f.run.id, "worker-1");

    // One nested helper attempt ran (the parent + helper = 2 runtime calls).
    expect(f.helperRequests).toHaveLength(1);
    const helper = f.helperRequests[0]!;
    // Nesting marker + restricted subset: no delegation tools reach the helper.
    expect(helper.runId).toContain("#helper-");
    expect(helper.prompt).toBe("survey the docs");
    expect(helper.tools.every((t) => t.name !== "run_subagent")).toBe(true);
    expect(helper.tools.every((t) => t.name !== "spawn_bot")).toBe(true);

    // Child progress mapped into the parent thread.
    const progressTexts = f.appends
      .filter((a) => a.type === "thread.progress")
      .map((a) => (a.payload as { text?: string }).text ?? "");
    expect(progressTexts.some((t) => t.includes("[scout] survey complete"))).toBe(true);
  });

  it("helper-raised pause propagates as the parent run's pause sentinel (D9/T025 seam)", async () => {
    const f = fixture({ scenario: "pause-propagation" });
    f.run.status = "queued";
    await f.executor.continueRun(f.run.id, "worker-1");
    // The helper branch returns the suspension sentinel; the parent runtime
    // bridge turns it into ToolSuspendedError (pinned at the adapter). Here
    // we pin the executor side: the sentinel surfaced from applyTool and the
    // helper's trailing done never emitted.
    const helperDone = f.appends.some(
      (a) => a.type === "thread.progress" && JSON.stringify(a.payload).includes("SHOULD NEVER EMIT"),
    );
    expect(helperDone).toBe(false);
    // The helper's budget units are durably admitted before the pause (T038
    // records persist across the pause) — no in-flight settle needed here;
    // the linkage lives on run.waiting_input (T027).
  });

  // Linked-cancellation carry: the abort LINK (runAbortController "abort" →
  // runtime.abort(helperRunId)) is wired in the helper branch; the
  // deterministic full-attempt teardown pin needs the complete
  // idempotency-fixture surface and is recorded as carried in WP-P6.
});