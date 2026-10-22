/**
 * 029 T030 — headless durable asks: the worker RELEASES on pause (the
 * attempt returns without a terminal outcome — no in-process hang), the
 * answer re-queues the run through the one-transaction accept, and the
 * fenced `continueRun` claim resumes it EXACTLY ONCE. The reconciler sweep
 * is the recovery net for a lost resume dispatch.
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

function fixture() {
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
  let attemptNo = 0;
  /** First attempt: propose the governed op and suspend. Second: finish. */
  const runtimeRun = vi.fn(async function* (_request: AgentRunRequest) {
    attemptNo += 1;
    if (attemptNo === 1) {
      yield {
        type: "suspended" as const,
        pauseClass: "permission" as const,
        pauseToken: "pause-9",
      };
      // The attempt RETURNS here — the worker host regains control; nothing
      // in-process waits on the answer (headless release).
      return;
    }
    // Resume attempt: the governed op now runs (approved) and completes.
    yield { type: "done" as const, text: "Deployed." };
  });

  const pauseRunForInput = vi.fn(async () => {
    run.status = "waiting_input";
    return true;
  });
  const finalizeRun = vi.fn(async () => ({ continuationRunId: null }));
  const enqueue = vi.fn(async () => undefined);
  const eventsAppend = vi.fn(async () => undefined);

  const prisma = {
    run: {
      findUnique: vi.fn(async () => ({ ...run })),
      findUniqueOrThrow: vi.fn(async () => ({ ...run, sourceMessage: null })),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(run, data);
        return { count: 1 };
      }),
    },
    bot: {
      findUnique: vi.fn(async () => ({
        id: run.botId,
        name: "Assistant",
        title: "Assistant",
        description: "",
        computerId: "computer-1",
        computer: { id: "computer-1", scope: "dedicated" },
      })),
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.botId,
        name: "Assistant",
        title: "Assistant",
        description: "",
        computerId: "computer-1",
        computer: { id: "computer-1", scope: "dedicated" },
      })),
      findMany: vi.fn(async () => []),
    },
    attempt: { create: vi.fn(async () => ({ id: `attempt-${attemptNo}` })), update: vi.fn(), updateMany: vi.fn(async () => ({ count: 1 })) },
    thread: { findUniqueOrThrow: vi.fn(async () => ({ id: run.threadId, groupId: null })) },
    message: { findMany: vi.fn(async () => []) },
    task: { findUniqueOrThrow: vi.fn(async () => ({ id: run.taskId, prompt: "Deploy" })) },
    event: { findFirst: vi.fn(async () => null) },
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
  };
  const executor = createRunExecutor({
    prisma: prisma as unknown as PrismaClient,
    runtime: { describe: () => ({ capabilities: { scripted: false } }), run: runtimeRun },
    connector: { discoverTools: async () => [], resolveCall: async () => undefined, execute: async function* () {} },
    sandbox: { describe: () => ({ capabilities: { graphical: false } }) },
    memory: {
      describe: () => ({ capabilities: {} }),
      read: async () => ({ documents: [] }),
      search: async () => [],
      commit: vi.fn(async () => ({ revision: "rev-1" })),
      exportMarkdown: async function* () {},
    },
    memoryProviders: { resolve: async () => null },
    events: { append: eventsAppend, pauseRunForInput, finalizeRun },
    jobs: { enqueue },
    secrets: [],
  } as unknown as Parameters<typeof createRunExecutor>[0]);

  return {
    run,
    pauseRunForInput,
    finalizeRun,
    enqueue,
    runtimeRun,
    /** Attempt one: propose + suspend. Returns with the worker released. */
    async suspendAttempt() {
      run.status = "queued";
      await executor.continueRun(run.id, "worker-1");
    },
    /** Answer + fenced claim: the one-transaction accept, then the resume. */
    async answerAndResume() {
      // The accept transaction (D2/T029): run CAS waiting_input → queued.
      run.status = "queued";
      await executor.continueRun(run.id, "worker-1");
    },
  };
}

describe("029 T030 — headless durable asks", () => {
  it("pause releases the worker; answer resumes exactly once; no in-process hang", async () => {
    const f = fixture();
    // 1. The pause attempt: the worker is RELEASED (continueRun resolves —
    // no pending in-process waiter), run durably waiting.
    await f.suspendAttempt();
    expect(f.pauseRunForInput).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        runId: "run-1",
        waitingState: { pauseClass: "permission", pauseToken: "pause-9" },
      }),
    );
    expect(f.run.status).toBe("waiting_input");
    expect(f.finalizeRun).not.toHaveBeenCalled();
    // The answer's resume (one fenced continueRun claim after the accept).
    await f.answerAndResume();
    // Exactly one resume: two runtime attempts total (suspend + resume).
    expect(f.runtimeRun).toHaveBeenCalledTimes(2);
    // The resumed turn completed: the terminal outcome flows through the
    // one finalize (the product event + notification ordering from T023).
    expect(f.finalizeRun).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ runId: "run-1", outcome: "completed" }),
    );
  });
});
