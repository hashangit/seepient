/**
 * 029 T026 — executor suspension handling: a suspended runtime event parks
 * the run at waiting_input (never cancelled/interrupted by the attempt
 * unwind), and the abort race resolves in exactly one direction.
 *
 * Fixture skeleton mirrors executor-effect-idempotency.test.ts / the
 * readonly-approval harness (provisionComputer stubbed).
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
    cancelBeforePause?: boolean;
    suspendEvent?: {
      pauseClass: "permission" | "choice" | "secret" | "takeover";
      pauseToken: string;
      request?: {
        mode: string;
        summary?: string;
        detail?: string;
        text?: string;
        actions?: Array<{ id: string; label: string }>;
        reason?: string;
      };
      tool?: string;
      auditBinding?: {
        actionId: string;
        actionDigest: string;
        principalId: string;
        runId: string;
      };
    };
  } = {},
) {
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
  const prisma = {
    run: {
      findUnique: vi.fn(async () => run),
      findUniqueOrThrow: vi.fn(async () => run),
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
        description: "Test assistant",
        computerId: "computer-1",
        computer: { id: "computer-1", scope: "dedicated" },
      })),
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.botId,
        name: "Assistant",
        title: "Assistant",
        description: "Test assistant",
        computerId: "computer-1",
        computer: { id: "computer-1", scope: "dedicated" },
      })),
      findMany: vi.fn(async () => []),
    },
    attempt: {
      create: vi.fn(async () => ({ id: "attempt-1" })),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    thread: { findUniqueOrThrow: vi.fn(async () => ({ id: run.threadId, groupId: null })) },
    message: { findMany: vi.fn(async () => []) },
    task: { findUniqueOrThrow: vi.fn(async () => ({ id: run.taskId, prompt: "Do the thing" })) },
    event: { findFirst: vi.fn(async () => null) },
    connection: { findMany: vi.fn(async () => []) },
    spaceModelPreference: { findFirst: vi.fn(async () => null) },
    userModelCredential: { findFirst: vi.fn(async () => null) },
    deploymentSettings: {
      findUnique: vi.fn(async () => ({
        defaultModelProvider: "scripted",
        defaultModelId: "scripted",
      })),
    },
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
  const pauseRunForInput = vi.fn(async (_input?: unknown) => {
    run.status = "waiting_input";
    return true;
  });
  const finalizeRun = vi.fn(async () => ({ continuationRunId: null }));
  const pauseRunForTakeover = vi.fn(async (_input?: unknown) => {
    run.status = "waiting_takeover";
    return true;
  });
  const runtimeRun = vi.fn(async function* (_request: AgentRunRequest) {
    if (options.cancelBeforePause) {
      // Direction (b): the owner cancelled the run while the turn was in
      // flight — the loop's lease re-check unwinds the attempt as cancelled
      // before the pause is consumed.
      run.status = "cancelled";
    }
    yield {
      type: "suspended" as const,
      pauseClass: (options.suspendEvent?.pauseClass ?? "permission") as "permission",
      pauseToken: options.suspendEvent?.pauseToken ?? "pause-9",
      ...(options.suspendEvent?.request ? { request: options.suspendEvent.request } : {}),
      ...(options.suspendEvent?.tool ? { tool: options.suspendEvent.tool } : {}),
      ...(options.suspendEvent?.auditBinding
        ? { auditBinding: options.suspendEvent.auditBinding }
        : {}),
    };
    yield { type: "done" as const, text: "SHOULD NEVER EMIT" };
  });
  const executor = createRunExecutor({
    prisma,
    runtime: { describe: () => ({ capabilities: { scripted: false } }), run: runtimeRun },
    connector: {
      discoverTools: async () => [],
      resolveCall: async () => undefined,
      execute: async function* () {},
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
    events: { append: vi.fn(async () => undefined), pauseRunForInput, pauseRunForTakeover, finalizeRun },
    jobs: { enqueue: vi.fn(async () => undefined) },
    secrets: [],
  } as unknown as Parameters<typeof createRunExecutor>[0]);

  return {
    run,
    pauseRunForInput,
    pauseRunForTakeover,
    finalizeRun,
    runtimeRun,
    async runAttempt() {
      run.status = "queued";
      await executor.continueRun(run.id, "worker-1");
    },
  };
}

describe("029 T026 — executor suspension handling", () => {
  it("parks the run at waiting_input without a terminal outcome (pause wins)", async () => {
    const f = fixture();
    await f.runAttempt();
    expect(f.pauseRunForInput).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        runId: "run-1",
        attemptId: "attempt-1",
        leaseOwner: "worker-1",
      }),
    );
    expect(f.run.status).toBe("waiting_input");
    // The unwind must not convert the pause into a terminal failure/cancel,
    // and the trailing done event never surfaced as a fabricated completion.
    expect(f.finalizeRun).not.toHaveBeenCalled();
  });

  it("abort race (cancel wins): a cancelled run never reaches waiting_input", async () => {
    const f = fixture({ cancelBeforePause: true });
    await f.runAttempt();
    expect(f.run.status).toBe("cancelled");
    expect(f.pauseRunForInput).not.toHaveBeenCalled();
  });

  // T028: each pause class renders its M02/M03-family card and pauses
  // through the right mechanism.
  it.each([
    [
      "permission",
      { mode: "permission", summary: "Deploy the staging build", detail: "via deploy.sh" },
    ],
    [
      "choice",
      { mode: "choice", text: "Pick a region", actions: [{ id: "eu", label: "EU" }, { id: "us", label: "US" }] },
    ],
    ["secret", { mode: "secret", text: "Enter the deploy token" }],
    [
      "takeover",
      { mode: "takeover", text: "Need the screen", reason: "Certificate prompt needs a human" },
    ],
  ])("class %s: typed card + correct pause mechanism", async (pauseClass, request) => {
    const f = fixture({ suspendEvent: { pauseClass: pauseClass as never, pauseToken: "tok-1", request: request as never } });
    await f.runAttempt();
    if (pauseClass === "takeover") {
      expect(f.pauseRunForTakeover).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          runId: "run-1",
          computerId: "computer-1",
          reason: "Certificate prompt needs a human",
        }),
      );
      expect(f.run.status).toBe("waiting_takeover");
      return;
    }
    expect(f.pauseRunForInput).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        runId: "run-1",
        waitingState: { pauseClass, pauseToken: "tok-1" },
      }),
    );
    const pauseCall = f.pauseRunForInput.mock.calls[0];
    if (!pauseCall) throw new Error("expected a pauseRunForInput call");
    const blocks = (pauseCall[0] as { blocks: Array<Record<string, unknown>> }).blocks;
    const meta = blocks.find((b) => b.kind === "meta");
    expect(meta).toEqual({ kind: "meta", text: `suspended:${pauseClass}:tok-1` });
    if (pauseClass === "permission") {
      const ask = blocks.find((b) => b.kind === "ask") as { text: string; detail?: string; actions: unknown[] };
      expect(ask.text).toBe("Deploy the staging build");
      expect(ask.detail).toBe("via deploy.sh");
      expect(ask.actions).toEqual([
        { id: "approve", label: "Approve" },
        { id: "deny", label: "Deny" },
      ]);
    }
    if (pauseClass === "choice") {
      const choice = blocks.find((b) => b.kind === "choice") as { question: string; options: unknown[] };
      expect(choice.question).toBe("Pick a region");
      expect(choice.options).toEqual([
        { id: "eu", letter: "E", label: "EU" },
        { id: "us", letter: "U", label: "US" },
      ]);
    }
    if (pauseClass === "secret") {
      const ask = blocks.find((b) => b.kind === "ask") as { text: string; input: string };
      // Prompt text only — the answer never rides the card into history.
      expect(ask.text).toBe("Enter the deploy token");
      expect(ask.input).toBe("secret");
    }
    if (pauseClass === "takeover") {
      const computer = blocks.find((b) => b.kind === "computer");
      expect(computer).toBeDefined();
    }
    expect(f.finalizeRun).not.toHaveBeenCalled();
  });

  it("parks the engine audit binding with the waiting state (P2.4 terminal-audit connection)", async () => {
    const auditBinding = {
      actionId: "action-1",
      actionDigest: "digest-1",
      principalId: "user-1",
      runId: "run-1",
    };
    const f = fixture({
      suspendEvent: {
        pauseClass: "permission",
        pauseToken: "tok-1",
        tool: "deploy_site",
        auditBinding,
      },
    });
    await f.runAttempt();
    expect(f.pauseRunForInput).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        runId: "run-1",
        waitingState: {
          pauseClass: "permission",
          pauseToken: "tok-1",
          tool: "deploy_site",
          auditBinding,
        },
      }),
    );
    expect(f.finalizeRun).not.toHaveBeenCalled();
  });
});
