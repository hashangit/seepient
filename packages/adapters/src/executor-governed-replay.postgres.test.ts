/**
 * 029 gate repair round 3 — executor replay journeys on REAL Postgres: the
 * durable decision recorded by the real accept arms a fresh executor process
 * (restart) exactly once, the governed dispatch consumes it durably (CAS
 * joined with the intended→approved flip), and a changed replay falls back to
 * a fresh approval card. The model is scripted (as in every executor test);
 * every store is the real one.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";

vi.mock("./computer-lifecycle.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./computer-lifecycle.js")>();
  return { ...actual, provisionComputer: async () => ({ id: "jrn-computer", kind: "desktop" }) };
});

import type { AgentRunRequest, AgentRuntimeEvent } from "@seepients/adapter-kit";
import { actionDigestOf } from "@seepients/db";
import { createDb, createThreadEvents, type PrismaClient } from "@seepients/db";
import { createRunExecutor } from "./executor.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("governed replay dispatch (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  const ids = {
    userId: "jrn2-owner-user",
    organizationId: "jrn2-org",
    spaceId: "jrn2-space",
    botId: "jrn2-bot",
    threadId: "jrn2-thread",
    computerId: "jrn-computer",
  };
  const seededRuns: string[] = [];

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };
    await prisma.user.create({
      data: { id: ids.userId, name: "Owner", email: "jrn2-owner@journeys.invalid" },
    });
    await prisma.organization.create({
      data: {
        id: ids.organizationId,
        name: "Journeys2",
        slug: "jrn2-governed",
        createdAt: new Date(),
      },
    });
    await prisma.space.create({
      data: { id: ids.spaceId, organizationId: ids.organizationId, name: "Journeys2" },
    });
    // The scripted deployment default (same projection the fixture harness
    // uses): model resolution succeeds without a stored credential.
    await prisma.deploymentSettings.create({
      data: { id: "default", defaultModelProvider: "scripted", defaultModelId: "scripted" },
    });
    await prisma.computer.create({
      data: {
        id: ids.computerId,
        spaceId: ids.spaceId,
        userId: ids.userId,
        scopeKey: "jrn2-scope",
        homeKey: "jrn2-home",
        kind: "desktop",
      },
    });
    await prisma.bot.create({
      data: {
        id: ids.botId,
        spaceId: ids.spaceId,
        userId: ids.userId,
        name: "J2",
        color: "#000000",
        computerId: ids.computerId,
      },
    });
    await prisma.thread.create({
      data: { id: ids.threadId, spaceId: ids.spaceId, botId: ids.botId, userId: ids.userId },
    });
  });

  afterAll(async () => {
    await prisma?.run.deleteMany({ where: { id: { in: seededRuns } } });
    await prisma?.computer.deleteMany({ where: { id: ids.computerId } });
    await prisma?.thread.deleteMany({ where: { id: ids.threadId } });
    await prisma?.bot.deleteMany({ where: { id: ids.botId } });
    await prisma?.deploymentSettings.deleteMany({ where: { id: "default" } });
    await prisma?.user.deleteMany({ where: { id: ids.userId } });
    await prisma?.organization.deleteMany({ where: { id: ids.organizationId } });
    await close?.();
  });

  const PAUSE_TOKEN = "pause-jrn2";
  const ARGS = { target: "prod" };

  async function seedQueuedRun(suffix: string): Promise<string> {
    const runId = `jrn2-run-${suffix}`;
    seededRuns.push(runId);
    await prisma.task.create({
      data: {
        id: `jrn2-task-${suffix}`,
        spaceId: ids.spaceId,
        botId: ids.botId,
        threadId: ids.threadId,
        userId: ids.userId,
        prompt: "Deploy the site",
        status: "queued",
      },
    });
    await prisma.run.create({
      data: {
        id: runId,
        spaceId: ids.spaceId,
        botId: ids.botId,
        threadId: ids.threadId,
        taskId: `jrn2-task-${suffix}`,
        userId: ids.userId,
        status: "queued",
        trigger: "webhook",
      },
    });
    return runId;
  }

  /** A scripted runtime: attempt events are fully controlled by the test. */
  interface ScriptedRuntime {
    describe: () => { capabilities: { scripted: boolean } };
    run: (request: AgentRunRequest) => AsyncGenerator<AgentRuntimeEvent, void, unknown>;
  }
  function scriptedRuntime(
    attempts: Array<{ events: AgentRuntimeEvent[]; dispatch?: boolean }>,
  ): ScriptedRuntime & { dispatches: Array<{ name: string; args: Record<string, unknown> }> } {
    let call = 0;
    const dispatches: Array<{ name: string; args: Record<string, unknown> }> = [];
    return {
      dispatches,
      // Real streaming-runtime mode: the executor must consume the scripted
      // events, not drive its internal scripted tool loop.
      describe: () => ({ capabilities: { scripted: false } }),
      run: async function* (request) {
        const attempt = attempts[Math.min(call, attempts.length - 1)]!;
        call += 1;
        for (const event of attempt.events) {
          if (event.type === "tool" && event.name === "deploy_site") {
            // The real runtime yields the tool event first, then dispatches
            // it through applyTool (wired as executeTool).
            yield event;
            if (attempt.dispatch) {
              const dispatch = request as Partial<Pick<AgentRunRequest, "executeTool">>;
              await dispatch.executeTool?.(event.name, event.args, event.executionId);
              dispatches.push({ name: event.name, args: event.args });
            }
            continue;
          }
          yield event;
        }
      },
    };
  }

  function buildExecutor(runtime: ScriptedRuntime) {
    const connectorExecute = vi.fn(async function* () {
      yield { type: "result" as const, data: { ok: true } };
    });
    const executor = createRunExecutor({
      prisma,
      runtime,
      connector: {
        discoverTools: async () => [],
        resolveCall: async () => undefined,
        execute: connectorExecute,
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
      events: createThreadEvents(prisma),
      jobs: { enqueue: vi.fn(async () => undefined) },
      secrets: [],
    } as unknown as Parameters<typeof createRunExecutor>[0]);
    return { executor, connectorExecute };
  }

  it("restart: a fresh executor re-derives arming from the durable decision and executes the effect exactly once", async () => {
    const runId = await seedQueuedRun("approve");
    // Attempt 1: the governed suspension parks the run (real pause, real
    // waitingState with the actionDigest of the EXACT suspended request).
    const first = scriptedRuntime([
      {
        events: [
          { type: "tool", name: "deploy_site", args: ARGS, executionId: "exec-1" },
          {
            type: "suspended",
            pauseClass: "permission",
            pauseToken: PAUSE_TOKEN,
            tool: "deploy_site",
          },
        ],
      },
    ]);
    const attempt1 = buildExecutor(first);
    await attempt1.executor.continueRun(runId, "worker-1");
    const run1 = await prisma.run.findUniqueOrThrow({ where: { id: runId } });
    expect(run1.status).toBe("waiting_input");
    const waiting = await prisma.event.findFirstOrThrow({
      where: { runId, type: "run.waiting_input" },
      orderBy: { seq: "desc" },
    });
    expect(waiting.payload).toMatchObject({
      pauseClass: "permission",
      pauseToken: PAUSE_TOKEN,
      tool: "deploy_site",
      actionDigest: actionDigestOf("deploy_site", ARGS),
    });

    // The real accept (threads.answer's transaction).
    const events = createThreadEvents(prisma);
    const card = await prisma.message.findFirstOrThrow({
      where: { threadId: ids.threadId, runId, role: "bot" },
      orderBy: { seq: "desc" },
    });
    expect(
      await events.answerRunInput({
        spaceId: ids.spaceId,
        threadId: ids.threadId,
        runId,
        messageId: card.id,
        answeredByUserId: ids.userId,
        answer: "approve",
      }),
    ).toBe(true);

    // Attempt 2 in a FRESH executor (nothing in memory): arming is re-derived
    // from the durable run.input_decision; the governed dispatch consumes it
    // durably and executes the effect exactly once.
    const second = scriptedRuntime([
      {
        events: [
          { type: "tool", name: "deploy_site", args: ARGS, executionId: "exec-2" },
          { type: "done", text: "deployed" },
        ],
        dispatch: true,
      },
    ]);
    const attempt2 = buildExecutor(second);
    await attempt2.executor.continueRun(runId, "worker-2");

    const effect = await prisma.externalEffect.findFirstOrThrow({ where: { runId } });
    expect(effect.status).toBe("completed");
    const decision = await prisma.event.findFirstOrThrow({
      where: { runId, type: "run.input_decision" },
      orderBy: { seq: "desc" },
    });
    expect(decision.payload).toMatchObject({ consumedAt: expect.any(String) });
    // Exactly one dispatch of the armed request, one connector execution.
    expect(second.dispatches).toEqual([{ name: "deploy_site", args: ARGS }]);
    expect(attempt2.connectorExecute).toHaveBeenCalledTimes(1);
    const run2 = await prisma.run.findUniqueOrThrow({ where: { id: runId } });
    expect(run2.status).toBe("completed");
  });

  it("changed arguments on resume: digest mismatch falls back to a fresh approval card, never auto-approval", async () => {
    const runId = await seedQueuedRun("changed");
    const first = scriptedRuntime([
      {
        events: [
          { type: "tool", name: "deploy_site", args: ARGS, executionId: "exec-1" },
          {
            type: "suspended",
            pauseClass: "permission",
            pauseToken: `${PAUSE_TOKEN}-c`,
            tool: "deploy_site",
          },
        ],
      },
    ]);
    const attempt1 = buildExecutor(first);
    await attempt1.executor.continueRun(runId, "worker-1");
    const events = createThreadEvents(prisma);
    const card = await prisma.message.findFirstOrThrow({
      where: { threadId: ids.threadId, runId, role: "bot" },
      orderBy: { seq: "desc" },
    });
    expect(
      await events.answerRunInput({
        spaceId: ids.spaceId,
        threadId: ids.threadId,
        runId,
        messageId: card.id,
        answeredByUserId: ids.userId,
        answer: "approve",
      }),
    ).toBe(true);

    // The resumed dispatch targets DIFFERENT arguments: the armed digest no
    // longer matches — a FRESH approval card is raised instead.
    const second = scriptedRuntime([
      {
        events: [
          {
            type: "tool",
            name: "deploy_site",
            args: { target: "staging" },
            executionId: "exec-2",
          },
          { type: "done", text: "should never run" },
        ],
        dispatch: true,
      },
    ]);
    const attempt2 = buildExecutor(second);
    await attempt2.executor.continueRun(runId, "worker-2");

    const run2 = await prisma.run.findUniqueOrThrow({ where: { id: runId } });
    expect(run2.status).toBe("waiting_input");
    // The decision was NOT consumed by the mismatched dispatch...
    const decision = await prisma.event.findFirstOrThrow({
      where: { runId, type: "run.input_decision" },
      orderBy: { seq: "desc" },
    });
    expect(decision.payload).toMatchObject({ consumedAt: null });
    // ...and the new card is the approval ask (effect-gated), not the
    // governed suspension meta.
    const approvalCard = await prisma.message.findFirstOrThrow({
      where: { threadId: ids.threadId, runId, role: "bot" },
      orderBy: { seq: "desc" },
    });
    const blocks = approvalCard.blocks as Array<Record<string, unknown>>;
    expect(blocks.some((block) => block.kind === "ask" && block.approvalEffectId)).toBe(true);
    expect(
      blocks.some(
        (block) =>
          block.kind === "meta" &&
          typeof block.text === "string" &&
          block.text.startsWith("suspended:"),
      ),
    ).toBe(false);
    // The changed call reached the governed dispatch boundary (its intended
    // effect row exists) but was NEVER approved or executed.
    const effects = await prisma.externalEffect.findMany({ where: { runId } });
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({ status: "intended" });
    expect(second.dispatches).toEqual([{ name: "deploy_site", args: { target: "staging" } }]);
    expect(attempt2.connectorExecute).not.toHaveBeenCalled();
  });

  it("deny on resume: the durable decision is spent once and the loop completes with the denial result, never re-pausing", async () => {
    const runId = await seedQueuedRun("deny");
    // Attempt 1: the governed suspension parks the run exactly like approve.
    const first = scriptedRuntime([
      {
        events: [
          { type: "tool", name: "deploy_site", args: ARGS, executionId: "exec-1" },
          {
            type: "suspended",
            pauseClass: "permission",
            pauseToken: `${PAUSE_TOKEN}-d`,
            tool: "deploy_site",
          },
        ],
      },
    ]);
    const attempt1 = buildExecutor(first);
    await attempt1.executor.continueRun(runId, "worker-1");
    const run1 = await prisma.run.findUniqueOrThrow({ where: { id: runId } });
    expect(run1.status).toBe("waiting_input");

    // The real accept with a denial answer — the synthesized decision
    // records "deny" bound to the suspension's actionDigest.
    const events = createThreadEvents(prisma);
    const card = await prisma.message.findFirstOrThrow({
      where: { threadId: ids.threadId, runId, role: "bot" },
      orderBy: { seq: "desc" },
    });
    expect(
      await events.answerRunInput({
        spaceId: ids.spaceId,
        threadId: ids.threadId,
        runId,
        messageId: card.id,
        answeredByUserId: ids.userId,
        answer: "deny",
      }),
    ).toBe(true);
    const decision = await prisma.event.findFirstOrThrow({
      where: { runId, type: "run.input_decision" },
      orderBy: { seq: "desc" },
    });
    expect(decision.payload).toMatchObject({
      decision: "deny",
      actionDigest: actionDigestOf("deploy_site", ARGS),
      consumedAt: null,
    });

    // Attempt 2 in a FRESH executor: the deny decision arms and is consumed
    // durably; the model-visible denial result completes the loop — no
    // second pause card, no effect execution.
    const second = scriptedRuntime([
      {
        events: [
          { type: "tool", name: "deploy_site", args: ARGS, executionId: "exec-2" },
          { type: "done", text: "understood, not deploying" },
        ],
        dispatch: true,
      },
    ]);
    const attempt2 = buildExecutor(second);
    await attempt2.executor.continueRun(runId, "worker-2");

    const spent = await prisma.event.findFirstOrThrow({
      where: { runId, type: "run.input_decision" },
      orderBy: { seq: "desc" },
    });
    expect(spent.payload).toMatchObject({ decision: "deny", consumedAt: expect.any(String) });
    // The intended effect was never approved or executed.
    const effect = await prisma.externalEffect.findFirstOrThrow({ where: { runId } });
    expect(effect.status).toBe("intended");
    expect(attempt2.connectorExecute).not.toHaveBeenCalled();
    // Exactly one dispatch (the denied re-dispatch), and the run COMPLETED —
    // the denial went back to the model instead of re-raising the pause.
    expect(second.dispatches).toEqual([{ name: "deploy_site", args: ARGS }]);
    const run2 = await prisma.run.findUniqueOrThrow({ where: { id: runId } });
    expect(run2.status).toBe("completed");
    const waitingEvents = await prisma.event.count({
      where: { runId, type: "run.waiting_input" },
    });
    expect(waitingEvents).toBe(1);
  });
});
