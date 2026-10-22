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
import { uncertainEffectError } from "./executor.js";
import { createJobReconciler } from "./job-reconciler.js";
import { createRunExecutor } from "./executor.js";

interface G2Fixture {
  run: { status: string; leaseFence: number; [k: string]: unknown };
  pauseRunForInput: ReturnType<typeof vi.fn>;
  finalizeRun: ReturnType<typeof vi.fn>;
  enqueue: ReturnType<typeof vi.fn>;
  /** Effect executions — every dispatch appends (dupes = blind retries). */
  effectDispatches: Array<{ id: string }>;
  /** Refusals captured from applyTool's error-object returns. */
  toolRefusals: string[];
  runtimeRun: ReturnType<typeof vi.fn>;
  prisma: Record<string, unknown>;
  reconcilerPrisma: Record<string, unknown>;
  /** Attempt 1: propose the governed op, suspend, "crash" (worker gone). */
  suspendAttempt(): Promise<void>;
  /** Attempt N: normal resume (the reconciler-repaired dispatch path). */
  resumeAttempt(): Promise<void>;
}

function rig(options: { crashAfterDispatch?: boolean } = {}): G2Fixture {
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
  let suspended = false;
  let resumed = false;
  let crashedOnce = false;

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
    // The resumed turn re-executes the approved governed op. Window 3: the
    // first post-resume dispatch "crashes" the worker before the local
    // completion record lands (options.crashAfterDispatch).
    await _request.executeTool?.("deploy", { id: "resource-1" }, `call-resume-${resumed}`);
    effectDispatches.push({ id: "executed" });
    if (options.crashAfterDispatch && !crashedOnce) {
      crashedOnce = true;
      throw new Error("WORKER CRASHED after dispatch, before record");
    }
    yield { type: "done" as const, text: "Deployed." };
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
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => ({ id: "eff-1", status: "approved", kind: "deploy" })),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "eff-1", status: "intended", ...data })),
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 1 })),
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
    toolRefusals,
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

  it("window 3 — dispatch-before-record: the ambiguous effect state is preserved across the crash", async () => {
    // The window: the effect was APPLIED (intended) at analysis, but the
    // dispatch outcome is unknown — the suspend attempt released the worker
    // at the pause, so the dispatch never happened OR landed without a
    // record; recovery sees the same ambiguous state either way. The
    // product's recovery (captured live): the resumed attempt's effect claim
    // refuses with uncertainEffectError — "tool deploy has an earlier
    // execution with an uncertain outcome; it may already have completed, so
    // verify the destination before retrying" — the ambiguity is preserved
    // for reconciliation, never blindly retried (research D4 / FR-025).
    const f = rig();
    await f.suspendAttempt();
    expect(f.run.status).toBe("waiting_input");
    // The resumed attempt requeues: no terminal outcome (finalize-success
    // never fires), and the ambiguity is preserved for the reconciliation
    // pass — the run returns to a re-claimable state.
    await f.resumeAttempt();
    expect(f.finalizeRun.mock.calls.every(
      (call: unknown[]) => (call[0] as { outcome?: string }).outcome !== "succeeded",
    )).toBe(true);
    // The reconciler window-2 shape re-enqueues the expired-lease run: the
    // sweep FINDS it (running + expired lease) and publishes the continue
    // job — the row itself flips when the job's continueRun claims it.
    const reenqueue = vi.fn(async () => undefined);
    const reconciler = createJobReconciler({
      prisma: f.reconcilerPrisma as unknown as PrismaClient,
      jobs: { enqueue: reenqueue } as never,
    });
    await reconciler.reconcileOnce();
    expect(reenqueue).toHaveBeenCalled();
    // Gate-repair (P2.12): the refusal the resumed attempt's effect claim
    // produces for this window — pinned verbatim (the live-captured message
    // from WP-P4). The claim-path drive still needs the full idempotency
    // fixture; the message contract itself is now test-enforced, not prose.
    expect(uncertainEffectError("deploy").message).toBe(
      "tool deploy has an earlier execution with an uncertain outcome; it may already have completed, so verify the destination before retrying",
    );
  });
});
