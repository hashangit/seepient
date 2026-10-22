/**
 * 029 T038 (FR-032/D5) — the durable SharedBudgetLedger: one shared
 * parent+helper tool-call budget enforced at pre-dispatch admission via
 * atomic admission records keyed by (runId, executionId). Restart
 * reconstructs the remaining budget by counting records.
 */
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@seepients/db";
import { SharedBudgetLedger } from "./shared-budget-ledger.js";

function ledgerHarness(budget: number) {
  const rows: Array<{ runId: string; executionId: string; callerKind: string }> = [];
  const admitted = new Set<string>();
  const sharedBudgetAdmission = {
    createMany: vi.fn(async ({ data }: { data: Array<{ runId: string; executionId: string; callerKind: string }> }) => {
      // Emulate the DB unique constraint: a duplicate executionId inside the
      // same createMany batch (or table) rejects atomically.
      for (const row of data) {
        const key = `${row.runId}:${row.executionId}`;
        if (admitted.has(key)) return { count: 0 };
        if (rows.length + data.length > budget + data.length - 1 && rows.length + data.length > budget) {
          // over-budget creation is handled by the ledger's count check before write
        }
      }
      for (const row of data) {
        const key = `${row.runId}:${row.executionId}`;
        if (rows.length >= budget) return { count: 0 };
        if (admitted.has(key)) return { count: 0 };
        admitted.add(key);
        rows.push(row);
      }
      return { count: data.length };
    }),
    findMany: vi.fn(async () => rows.map((r) => ({ ...r }))),
    deleteMany: vi.fn(async () => ({ count: 0 })),
  };
  const prisma = {
    $transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb({ sharedBudgetAdmission })),
    sharedBudgetAdmission,
  } as unknown as PrismaClient & { sharedBudgetAdmission: typeof sharedBudgetAdmission };
  return { ledger: new SharedBudgetLedger(prisma, budget), rows, prisma, sharedBudgetAdmission };
}

describe("SharedBudgetLedger (029 T038 / FR-032 / D5)", () => {
  it("admits parent and helper calls until the budget is exhausted (last-unit contention)", async () => {
    const { ledger } = ledgerHarness(2);
    expect(await ledger.admit("run-1", "exec-parent", "parent")).toBe(true);
    // Two concurrent helpers race for the last unit: exactly one wins.
    const [a, b] = await Promise.all([
      ledger.admit("run-1", "exec-helper-1", "helper"),
      ledger.admit("run-1", "exec-helper-2", "helper"),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(await ledger.admit("run-1", "exec-after", "helper")).toBe(false);
  });

  it("restart reconstructs the count from durable admission records (no fresh allowance)", async () => {
    const first = ledgerHarness(3);
    await first.ledger.admit("run-1", "e1", "parent");
    await first.ledger.admit("run-1", "e2", "helper");
    // "Restart": a NEW ledger instance over the same durable rows.
    const restarted = new SharedBudgetLedger(first.prisma as PrismaClient, 3);
    expect(await restarted.used("run-1")).toBe(2);
    expect(await restarted.admit("run-1", "e3", "helper")).toBe(true);
    expect(await restarted.admit("run-1", "e4", "helper")).toBe(false);
  });

  it("duplicate executionIds are idempotent (one admission per execution)", async () => {
    const { ledger } = ledgerHarness(5);
    expect(await ledger.admit("run-1", "exec-1", "parent")).toBe(true);
    expect(await ledger.admit("run-1", "exec-1", "parent")).toBe(true); // idempotent replay
    expect(await ledger.used("run-1")).toBe(1);
  });
});
