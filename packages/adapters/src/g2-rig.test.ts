/**
 * 029 T031 — the G2 rig: reproduces the three crash windows on demand
 * against the composition the product actually runs (the real executor +
 * the real reconciler + the real accept/expire paths — mocks only at the
 * DB/transport boundary):
 *
 *   1. accept-before-dispatch  → the reconciler re-enqueues the queued run.
 *   2. claim-before-model-call → lease expiry → the reconciler reclaims.
 *   3. dispatch-before-record  → the approved-effect replay dispatches the
 *      effect exactly once; the ambiguous window is preserved, not retried
 *      blindly (crash between dispatch and the local completion record).
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

import type { AgentRunRequest, ConnectorCall } from "@seepients/adapter-kit";
import type { PrismaClient } from "@seepients/db";
import { createJobReconciler } from "./job-reconciler.js";
import { createRunExecutor } from "./executor.js";

interface G2Fixture {
  run: { status: string; leaseFence: number; [k: string]: unknown };
  pauseRunForInput: ReturnType<typeof vi.fn>;
  finalizeRun: ReturnType<typeof vi.fn>;
  enqueue: ReturnType<typeof vi.fn>;
  /** Effect executions — every dispatch appends (dupes = blind retries). */
  effectDispatches: Array<{ id: string }>;
  /** Tool results from the resumed turn's governed-op executions, in call order. */
  toolResults: unknown[];
  /** externalEffect.updateMany transitions observed from the executor. */
  effectMutations: Array<{ from: string | undefined; to: string }>;
  runtimeRun: ReturnType<typeof vi.fn>;
  prisma: Record<string, unknown>;
  reconcilerPrisma: Record<string, unknown>;
  /** Attempt 1: propose the governed op, suspend, "crash" (worker gone). */
  suspendAttempt(): Promise<void>;
  /** Attempt N: normal resume (the reconciler-repaired dispatch path). */
  resumeAttempt(): Promise<void>;
}

function rig(options: { crashBeforeRecord?: boolean } = {}): G2Fixture {
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
  const effectDispatches: Array<{ id: string }> = [];
  const toolRefusals: string[] = [];
  /** Tool results from the resumed turn's governed-op executions, in order. */
  const toolResults: unknown[] = [];
  /** externalEffect.updateMany transitions observed from the executor. */
  const effectMutations: Array<{ from: string | undefined; to: string }> = [];
  let effect: Record<string, unknown> | null = null;
  let suspended = false;
  let resumed = false;

  const pauseRunForInput = vi.fn(async () => {
    run.status = "waiting_input";
    return true;
  });
  const finalizeRun = vi.fn(async () => ({ continuationRunId: null }));

  const runtimeRun = vi.fn(async function* (_request: AgentRunRequest) {
    if (!suspended) {
      suspended = true;
      yield {
        type: "suspended" as const,
        pauseClass: "permission" as const,
        pauseToken: "pause-9",
      };
      return;
    }
    resumed = true;
    // The resumed turn re-executes the governed op under the SAME execution
    // id. Window 3 (options.crashBeforeRecord): the first execution's
    // dispatch lands but the worker dies before the local completion record
    // is written (the rig's externalEffect mock drops the
    // executing→completed transition); the recovery execution must meet the
    // uncertain-effect refusal, never a second dispatch.
    const executionId = `call-resume-${resumed}`;
    for (let pass = 1; pass <= (options.crashBeforeRecord ? 2 : 1); pass += 1) {
      try {
        const result = await _request.executeTool?.("deploy", { id: "resource-1" }, executionId);
        toolResults.push(result);
      } catch (error) {
        toolResults.push({ threw: error instanceof Error ? error.message : String(error) });
      }
    }
    if (!options.crashBeforeRecord) {
      yield { type: "done" as const, text: "Deployed." };
    }
  });

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
        title: "",
        description: "",
        computerId: "computer-1",
        computer: { id: "computer-1", scope: "dedicated" },
      })),
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.botId,
        name: "Assistant",
        title: "",
        description: "",
        computerId: "computer-1",
        computer: { id: "computer-1", scope: "dedicated" },
      })),
      findMany: vi.fn(async () => []),
    },
    attempt: { create: vi.fn(async () => ({ id: `attempt-${Math.random()}` })), update: vi.fn(), updateMany: vi.fn(async () => ({ count: 1 })) },
    event: { findFirst: vi.fn(async () => null) },
    thread: { findUniqueOrThrow: vi.fn(async () => ({ id: run.threadId, groupId: null })) },
    message: { findMany: vi.fn(async () => []) },
    task: { findUniqueOrThrow: vi.fn(async () => ({ id: run.taskId, prompt: "Deploy" })) },
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
    externalEffect: {
      findMany: vi.fn(async () => (effect ? [{ ...effect }] : [])),
      findUnique: vi.fn(async () => (effect ? { ...effect } : null)),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        effect = { id: "eff-1", ...data };
        return { ...effect };
      }),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (effect) effect = { ...effect, ...data };
        return { ...effect };
      }),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { status?: string };
          data: { status: string };
        }) => {
          effectMutations.push({ from: where.status, to: data.status });
          if (!effect) return { count: 0 };
          // Window 3 crash simulation: the dispatch reached the connector but
          // the worker died before completeExternalEffect could write the
          // local completion record — the effect stays "executing" forever.
          if (
            options.crashBeforeRecord &&
            where.status === "executing" &&
            data.status === "completed"
          ) {
            return { count: 0 };
          }
          if (where.status === undefined || where.status === effect.status) {
            effect = { ...effect, ...data };
            return { count: 1 };
          }
          return { count: 0 };
        },
      ),
    },
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
  };
  const executor = createRunExecutor({
    prisma: prisma as unknown as PrismaClient,
    runtime: { describe: () => ({ capabilities: { scripted: false } }), run: runtimeRun },
    connector: {
      discoverTools: async () => [
        {
          name: "deploy",
          description: "Governed deploy op",
          readOnly: true,
          inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
          route: { connectorId: "demo", resourceId: "resource-1", toolName: "deploy" },
        },
      ],
      resolveCall: async () => undefined,
      execute: vi.fn(async function* (call: ConnectorCall) {
        effectDispatches.push({ id: (call.args as { id: string }).id });
        yield { type: "result" as const, data: { deployed: true } };
      }),
    },
    sandbox: { describe: () => ({ capabilities: { graphical: false } }) },
    memory: {
      describe: () => ({ capabilities: {} }),
      read: async () => ({ documents: [] }),
      search: async () => [],
      commit: vi.fn(async () => ({ revision: "rev-1" })),
      exportMarkdown: async function* () {},
    },
    memoryProviders: { resolve: async () => null },
    events: { append: vi.fn(async () => undefined), pauseRunForInput, finalizeRun },
    jobs: { enqueue: vi.fn(async () => undefined) },
    secrets: [],
  } as unknown as Parameters<typeof createRunExecutor>[0]);

  // The reconciler's prisma: the sweep queries share the run row state.
  const reconcilerPrisma = {
    run: {
      findMany: vi.fn(async ({ where }: { where?: { AND?: Array<Record<string, unknown>> } } = {}) => {
        const or = (where?.AND?.[0] as { OR?: Array<Record<string, unknown>> } | undefined)?.OR ?? [];
        const wantsQueued = or.some((c) => {
          if (typeof c === "string") return c === "queued";
          if (typeof c === "object" && c !== null && "status" in c) {
            return (c as { status: unknown }).status === "queued";
          }
          return false;
        });
        const wantsExpiredLease = or.some((c) => {
          if (typeof c !== "object" || c === null || !("status" in c)) return false;
          const status = (c as { status: unknown }).status;
          return (
            typeof status === "object" &&
            status !== null &&
            "in" in status &&
            Array.isArray((status as { in: unknown }).in)
          );
        });
        if (wantsQueued && run.status === "queued") return [{ id: run.id, updatedAt: new Date(0) }];
        if (wantsExpiredLease && run.status === "running") return [{ id: run.id, updatedAt: new Date(0) }];
        return [];
      }),
    },
    routine: { findMany: vi.fn(async () => []) },
    computer: { findMany: vi.fn(async () => []) },
    messagingOutbound: { findFirst: vi.fn(async () => null) },
  };

  return {
    run,
    pauseRunForInput,
    finalizeRun,
    enqueue: vi.fn(async () => undefined),
    effectDispatches,
    toolResults,
    effectMutations,
    runtimeRun,
    prisma,
    reconcilerPrisma,
    async suspendAttempt() {
      const executor = createRunExecutor({
        prisma: prisma as unknown as PrismaClient,
        runtime: { describe: () => ({ capabilities: { scripted: false } }), run: runtimeRun },
        connector: { discoverTools: async () => [], resolveCall: async () => undefined, execute: async function* () {} },
        sandbox: { describe: () => ({ capabilities: { graphical: false } }) },
        memory: { describe: () => ({ capabilities: {} }), read: async () => ({ documents: [] }), search: async () => [], commit: vi.fn(async () => ({})), exportMarkdown: async function* () {} },
        memoryProviders: { resolve: async () => null },
        events: { append: vi.fn(async () => undefined), pauseRunForInput, finalizeRun },
        jobs: { enqueue: vi.fn(async () => undefined) },
        secrets: [],
      } as unknown as Parameters<typeof createRunExecutor>[0]);
      run.status = "queued";
      await executor.continueRun(run.id, "worker-1");
    },
    async resumeAttempt() {
      const exec = createRunExecutor({
        prisma: prisma as unknown as PrismaClient,
        runtime: { describe: () => ({ capabilities: { scripted: false } }), run: runtimeRun },
        connector: {
          discoverTools: async () => [
            {
              name: "deploy",
              description: "Governed deploy op",
              inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
              route: { connectorId: "demo", resourceId: "resource-1", toolName: "deploy" },
            },
          ],
          resolveCall: async () => undefined,
          execute: vi.fn(async function* (call: ConnectorCall) {
            effectDispatches.push({ id: (call.args as { id: string }).id });
            yield { type: "result" as const, data: { deployed: true } };
          }),
        },
        sandbox: { describe: () => ({ capabilities: { graphical: false } }) },
        memory: { describe: () => ({ capabilities: {} }), read: async () => ({ documents: [] }), search: async () => [], commit: vi.fn(async () => ({})), exportMarkdown: async function* () {} },
        memoryProviders: { resolve: async () => null },
        events: { append: vi.fn(async () => undefined), pauseRunForInput, finalizeRun },
        jobs: { enqueue: vi.fn(async () => undefined) },
        secrets: [],
      } as unknown as Parameters<typeof createRunExecutor>[0]);
      run.status = "queued";
      await exec.continueRun(run.id, "worker-2");
    },
  };
}

describe("029 T031 — G2 rig: the three crash windows", () => {
  it("window 1 — accept-before-dispatch: the reconciler re-enqueues the queued run", async () => {
    const f = rig();
    // Pause → the answer accepts (run flips queued) → the dispatch job is
    // LOST (the worker crashed between the accept transaction and the
    // resume dispatch).
    await f.suspendAttempt();
    expect(f.run.status).toBe("waiting_input");
    f.run.status = "queued"; // the accept transaction committed
    // The reconciler sweep runs: it must FIND the queued run.
    const reconciler = createJobReconciler({
      prisma: f.reconcilerPrisma as unknown as PrismaClient,
      jobs: { enqueue: f.enqueue } as never,
    });
    await reconciler.reconcileOnce();
    // The sweep saw the queued run and re-enqueued its continuation job.
    expect(f.enqueue).toHaveBeenCalled();
  });

  it("window 2 — claim-before-model-call: lease expiry → the reconciler reclaims", async () => {
    const f = rig();
    // The resume claimed the lease (running) and the worker crashed before
    // any model call; the lease expired.
    f.run.status = "running";
    f.run.leaseFence = 2;
    const reconciler = createJobReconciler({
      prisma: f.reconcilerPrisma as unknown as PrismaClient,
      jobs: { enqueue: f.enqueue } as never,
    });
    await reconciler.reconcileOnce();
    // The sweep found the expired-lease running run and re-enqueued it.
    expect(f.enqueue).toHaveBeenCalled();
  });

  it("window 3 — dispatch-before-record: recovery meets the uncertain-effect refusal, never a replay", async () => {
    // The window: the governed effect was dispatched to the connector, but
    // the worker crashed before the local completion record was written —
    // the effect row is stuck "executing" and the outcome is genuinely
    // ambiguous (it may have completed remotely). Recovery re-executes the
    // same governed op; the product must refuse with the uncertain-effect
    // result instead of blindly replaying the dispatch.
    const f = rig({ crashBeforeRecord: true });
    await f.suspendAttempt();
    expect(f.run.status).toBe("waiting_input");
    await f.resumeAttempt();
    // The dispatch happened exactly once: the recovery pass did NOT reach
    // the connector again. If the refusal ever disappears, this becomes 2.
    expect(f.effectDispatches).toEqual([{ id: "resource-1" }]);
    // The effect lifecycle across the window: claimed for the dispatch
    // (intended → executing), the completion record write never landed
    // (the crash), then the refusal settles the ambiguity (executing →
    // uncertain) so reconciliation sees a preserved, not retried, state.
    expect(f.effectMutations).toEqual([
      { from: "intended", to: "executing" },
      { from: "executing", to: "completed" },
      { from: "executing", to: "uncertain" },
    ]);
    // Both the crash-interrupted execution and the recovery execution return
    // the uncertain-effect refusal (never a fake success, never a throw the
    // runtime would blindly retry).
    expect(f.toolResults).toHaveLength(2);
    for (const result of f.toolResults) {
      if (result && typeof result === "object" && "uncertain" in result) {
        expect(result.uncertain).toBe(true);
        if ("error" in result) {
          expect(typeof result.error).toBe("string");
          expect(result.error).toContain("outcome is unknown");
          expect(result.error).toContain("not replayed");
        }
      } else {
        throw new Error(`expected an uncertain-effect refusal result, got ${JSON.stringify(result)}`);
      }
    }
  });
});
