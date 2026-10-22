/**
 * 029 gate repair round 3 — governed continuation journeys against the REAL
 * accept path (real Postgres): real pauseRunForInput writes the waiting card,
 * real answerRunInput (the threads.answer service's accept transaction)
 * records the decision, and the durable record is exactly what the resumed
 * attempt re-derives arming from.
 *
 * Gate convention: VERIFY_DATABASE + DATABASE_URL (see messaging.postgres.test.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actionDigestOf } from "./governed-decision.js";
import { createDb, type PrismaClient } from "./client.js";
import { createThreadEvents, type ThreadEvents } from "./events.js";
import { SharedBudgetLedger } from "./shared-budget-ledger.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("governed continuation decisions (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let events: ThreadEvents;
  const ids = {
    userId: "jrn-owner-user",
    otherUserId: "jrn-other-user",
    organizationId: "jrn-org",
    spaceId: "jrn-space",
    botId: "jrn-bot",
    threadId: "jrn-thread",
  };
  const seededRuns: string[] = [];

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    events = createThreadEvents(prisma);
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };
    await prisma.user.create({
      data: { id: ids.userId, name: "Owner", email: "jrn-owner@journeys.invalid" },
    });
    await prisma.user.create({
      data: { id: ids.otherUserId, name: "Other", email: "jrn-other@journeys.invalid" },
    });
    await prisma.organization.create({
      data: {
        id: ids.organizationId,
        name: "Journeys",
        slug: "jrn-governed",
        createdAt: new Date(),
      },
    });
    await prisma.space.create({
      data: { id: ids.spaceId, organizationId: ids.organizationId, name: "Journeys" },
    });
    await prisma.member.create({
      data: {
        id: "jrn-member-other",
        organizationId: ids.organizationId,
        userId: ids.otherUserId,
        role: "owner",
        createdAt: new Date(),
      },
    });
    await prisma.bot.create({
      data: { id: ids.botId, spaceId: ids.spaceId, userId: ids.userId, name: "J", color: "#000000" },
    });
    await prisma.thread.create({
      data: { id: ids.threadId, spaceId: ids.spaceId, botId: ids.botId, userId: ids.userId },
    });
  });

  afterAll(async () => {
    // Children cascade (runs, messages, events, effects); admissions are run-cascaded too.
    await prisma?.run.deleteMany({ where: { id: { in: seededRuns } } });
    await prisma?.thread.deleteMany({ where: { id: ids.threadId } });
    await prisma?.bot.deleteMany({ where: { id: ids.botId } });
    await prisma?.user.deleteMany({ where: { id: { in: [ids.userId, ids.otherUserId] } } });
    await prisma?.organization.deleteMany({ where: { id: ids.organizationId } });
    await close?.();
  });

  /** Seed a paused governed permission run the way the executor's suspended
   * handler does: real pauseRunForInput over a running leased attempt. */
  async function seedPausedRun(options: {
    suffix: string;
    answerer?: string;
    expiresAt?: string;
    answer?: string;
  }): Promise<{ runId: string; pauseToken: string }> {
    const runId = `jrn-run-${options.suffix}`;
    const taskId = `jrn-task-${options.suffix}`;
    const attemptId = `jrn-attempt-${options.suffix}`;
    const pauseToken = `pause-${options.suffix}`;
    seededRuns.push(runId);
    await prisma.task.create({
      data: {
        id: taskId,
        spaceId: ids.spaceId,
        botId: ids.botId,
        threadId: ids.threadId,
        userId: ids.userId,
        prompt: "Deploy the site",
        status: "running",
      },
    });
    await prisma.run.create({
      data: {
        id: runId,
        spaceId: ids.spaceId,
        botId: ids.botId,
        threadId: ids.threadId,
        taskId,
        userId: ids.userId,
        status: "running",
        trigger: "user",
        leaseOwner: "worker-1",
        leaseFence: 3,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    await prisma.attempt.create({
      data: { id: attemptId, runId, fence: 3, status: "running" },
    });
    const paused = await events.pauseRunForInput({
      spaceId: ids.spaceId,
      threadId: ids.threadId,
      botId: ids.botId,
      runId,
      attemptId,
      leaseOwner: "worker-1",
      leaseFence: 3,
      blocks: [
        {
          kind: "ask",
          text: "Approve deploy?",
          status: "pending",
          actions: [
            { id: "approve", label: "Approve" },
            { id: "deny", label: "Deny" },
          ],
        },
        { kind: "meta", text: `suspended:permission:${pauseToken}` },
      ],
      waitingState: {
        pauseClass: "permission",
        pauseToken,
        tool: "deploy_site",
        actionDigest: actionDigestOf("deploy_site", { target: "prod" }),
        ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
      },
    });
    expect(paused).toBe(true);
    return { runId, pauseToken };
  }

  function cardRow(runId: string) {
    return prisma.message.findFirstOrThrow({
      where: { threadId: ids.threadId, runId, role: "bot" },
      orderBy: { seq: "desc" },
    });
  }

  function decisions(runId: string) {
    return prisma.event.findMany({
      where: { runId, type: "run.input_decision" },
      orderBy: { seq: "asc" },
    });
  }

  it("approve: the real accept records the full continuation binding and consumes nothing yet", async () => {
    const { runId, pauseToken } = await seedPausedRun({ suffix: "approve" });
    const answered = await events.answerRunInput({
      spaceId: ids.spaceId,
      threadId: ids.threadId,
      runId,
      messageId: (await cardRow(runId)).id,
      answeredByUserId: ids.userId,
      answer: "approve",
    });
    expect(answered).toBe(true);

    const run = await prisma.run.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe("queued");
    const rows = await decisions(runId);
    expect(rows).toHaveLength(1);
    const payload = rows[0]!.payload as Record<string, unknown>;
    expect(payload).toEqual({
      requestId: pauseToken,
      pauseClass: "permission",
      decision: "approve",
      answerDigest: actionDigestOf("deploy_site", { target: "prod" }),
      actionDigest: actionDigestOf("deploy_site", { target: "prod" }),
      operationRef: `pause:${pauseToken}`,
      tool: "deploy_site",
      consumedAt: null,
      answeredByUserId: ids.userId,
      recordedAnswer: "approve",
    });
    // The card's ask block is answered exactly once.
    const card = await cardRow(runId);
    const ask = (card.blocks as Array<Record<string, unknown>>).find((b) => b.kind === "ask");
    expect(ask).toMatchObject({ status: "answered", answer: "approve" });
  });

  it("deny: the decision records deny; the intended effect is untouched", async () => {
    const { runId, pauseToken } = await seedPausedRun({ suffix: "deny" });
    const effectId = "jrn-effect-deny";
    await prisma.externalEffect.create({
      data: {
        id: effectId,
        spaceId: ids.spaceId,
        runId,
        kind: "deploy_site",
        idempotencyKey: `${runId}:deploy_site`,
        status: "intended",
        request: { target: "prod" },
      },
    });
    const answered = await events.answerRunInput({
      spaceId: ids.spaceId,
      threadId: ids.threadId,
      runId,
      messageId: (await cardRow(runId)).id,
      answeredByUserId: ids.userId,
      answer: "deny",
    });
    expect(answered).toBe(true);
    const rows = await decisions(runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toMatchObject({
      requestId: pauseToken,
      decision: "deny",
      consumedAt: null,
    });
    expect(await prisma.externalEffect.findUniqueOrThrow({ where: { id: effectId } }))
      .toMatchObject({ status: "intended" });
  });

  it("duplicate: a second answer to the same card is refused; exactly one decision exists", async () => {
    const { runId } = await seedPausedRun({ suffix: "dup" });
    const messageId = (await cardRow(runId)).id;
    expect(
      await events.answerRunInput({
        spaceId: ids.spaceId,
        threadId: ids.threadId,
        runId,
        messageId,
        answeredByUserId: ids.userId,
        answer: "approve",
      }),
    ).toBe(true);
    expect(
      await events.answerRunInput({
        spaceId: ids.spaceId,
        threadId: ids.threadId,
        runId,
        messageId,
        answeredByUserId: ids.userId,
        answer: "approve",
      }),
    ).toBe(false);
    expect(await decisions(runId)).toHaveLength(1);
  });

  it("foreign principal: a non-owner's permission answer never accepts", async () => {
    const { runId } = await seedPausedRun({ suffix: "foreign" });
    const outcome = await events.answerRunInput({
      spaceId: ids.spaceId,
      threadId: ids.threadId,
      runId,
      messageId: (await cardRow(runId)).id,
      answeredByUserId: ids.otherUserId,
      answer: "approve",
    });
    expect(outcome).toBe(false);
    expect(await prisma.run.findUniqueOrThrow({ where: { id: runId } }))
      .toMatchObject({ status: "waiting_input" });
    expect(await decisions(runId)).toHaveLength(0);
  });

  it("expiry: an expired pause cancels the run on answer; nothing accepts", async () => {
    const { runId } = await seedPausedRun({
      suffix: "expired",
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });
    const outcome = await events.answerRunInput({
      spaceId: ids.spaceId,
      threadId: ids.threadId,
      runId,
      messageId: (await cardRow(runId)).id,
      answeredByUserId: ids.userId,
      answer: "approve",
    });
    expect(outcome).toBe(false);
    expect(await prisma.run.findUniqueOrThrow({ where: { id: runId } }))
      .toMatchObject({ status: "cancelled" });
    expect(await decisions(runId)).toHaveLength(0);
  });

  it("budget: concurrent admit() on two connections serializes — exactly one winner over the cap", async () => {
    // Two independent pools = two real connections racing the same run.
    const second = createDb(databaseUrl!);
    try {
      const runId = "jrn-run-budget";
      seededRuns.push(runId);
      await prisma.task.create({
        data: {
          id: "jrn-task-budget",
          spaceId: ids.spaceId,
          botId: ids.botId,
          threadId: ids.threadId,
          userId: ids.userId,
          prompt: "budget",
          status: "running",
        },
      });
      await prisma.run.create({
        data: {
          id: runId,
          spaceId: ids.spaceId,
          botId: ids.botId,
          threadId: ids.threadId,
          taskId: "jrn-task-budget",
          userId: ids.userId,
          status: "running",
          trigger: "user",
        },
      });
      const ledgerA = new SharedBudgetLedger(prisma, 1);
      const ledgerB = new SharedBudgetLedger(second.prisma, 1);
      // Both dispatch boundaries admit at the same moment: Serializable makes
      // one side abort (P2034) and the ledger's one retry re-derives from the
      // committed state — the over-cap side is refused, never double-charged.
      const [a, b] = await Promise.all([
        ledgerA.admit(runId, "exec-a", "parent"),
        ledgerB.admit(runId, "exec-b", "parent"),
      ]);
      expect([a, b].filter(Boolean)).toHaveLength(1);
      expect(await prisma.sharedBudgetAdmission.findMany({ where: { runId } })).toHaveLength(1);
      // Idempotent replay of the WINNER's executionId stays admitted without
      // a second record (exactly-once admission per execution).
      const winner = a ? ledgerA : ledgerB;
      expect(await winner.admit(runId, a ? "exec-a" : "exec-b", "parent")).toBe(true);
      expect(await prisma.sharedBudgetAdmission.findMany({ where: { runId } })).toHaveLength(1);
      // The loser's execution is refused on a clean retry too (budget spent).
      const loser = a ? ledgerB : ledgerA;
      expect(await loser.admit(runId, "exec-b", "parent")).toBe(false);
      expect(await prisma.sharedBudgetAdmission.findMany({ where: { runId } })).toHaveLength(1);
    } finally {
      await second.prisma.$disconnect();
      await second.pool.end();
    }
  });
});
