/**
 * 029 T038 (FR-032/D5) — the durable SharedBudgetLedger: one shared
 * parent+helper tool-call budget enforced at pre-dispatch admission via
 * atomic admission records keyed by (runId, executionId). Restart
 * reconstructs the remaining budget by counting records.
 *
 * Gate-review repair: the fake no longer enforces the budget inside
 * createMany (the old mock masked the ledger's own count check). The
 * concurrency claim is backed by the Serializable-isolation pin instead —
 * a fake prisma cannot model Postgres abort semantics, so the pin asserts
 * the ledger DECLARES the isolation that makes count-then-insert race-free
 * rather than pretending to simulate it.
 */
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@seepients/db";
import { parseRunToolCallBudget, SharedBudgetLedger } from "./shared-budget-ledger.js";

function ledgerHarness(budget: number) {
  const rows: Array<{ runId: string; executionId: string; callerKind: string }> = [];
  const admitted = new Set<string>();
  const txOptions: Array<unknown> = [];
  const sharedBudgetAdmission = {
    createMany: vi.fn(async ({ data }: { data: Array<{ runId: string; executionId: string; callerKind: string }> }) => {
      // Emulate ONLY the DB unique constraint on (runId, executionId).
      // Budget enforcement belongs to the ledger's serializable count check,
      // not to the fake — enforcing it here is what masked the race.
      for (const row of data) {
        const key = `${row.runId}:${row.executionId}`;
        if (admitted.has(key)) return { count: 0 };
      }
      for (const row of data) {
        const key = `${row.runId}:${row.executionId}`;
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
    $transaction: vi.fn(async (cb: (tx: unknown) => unknown, options?: unknown) => {
      txOptions.push(options);
      return cb({ sharedBudgetAdmission });
    }),
    sharedBudgetAdmission,
  } as unknown as PrismaClient & { sharedBudgetAdmission: typeof sharedBudgetAdmission };
  return {
    ledger: new SharedBudgetLedger(prisma, budget),
    rows,
    prisma,
    sharedBudgetAdmission,
    txOptions,
  };
}

describe("SharedBudgetLedger (029 T038 / FR-032 / D5)", () => {
  it("admits calls until the budget is exhausted; the last unit is refused (count check)", async () => {
    const { ledger } = ledgerHarness(2);
    expect(await ledger.admit("run-1", "exec-parent", "parent")).toBe(true);
    expect(await ledger.admit("run-1", "exec-helper-1", "helper")).toBe(true);
    // The next unit is past the ceiling: refused by the ledger's count check
    // inside the admission transaction (not by any fake-side enforcement).
    expect(await ledger.admit("run-1", "exec-helper-2", "helper")).toBe(false);
    expect(await ledger.admit("run-1", "exec-after", "helper")).toBe(false);
    expect(await ledger.used("run-1")).toBe(2);
  });

  it("admission transactions declare Serializable isolation (the concurrency guarantee)", async () => {
    const { ledger, txOptions } = ledgerHarness(2);
    await ledger.admit("run-1", "exec-1", "parent");
    expect(txOptions.length).toBeGreaterThan(0);
    for (const options of txOptions) {
      expect(options).toEqual({ isolationLevel: "Serializable" });
    }
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

// 029 gate repair (D1): the ONE parse both roots share — the worker bug was
// that unset disabled the ledger while the api defaulted to 400.
describe("parseRunToolCallBudget (shared api+worker semantics)", () => {
  it("unset and blank mean the 400 default (budget ON, never off)", () => {
    expect(parseRunToolCallBudget(undefined)).toBe(400);
    expect(parseRunToolCallBudget("")).toBe(400);
    expect(parseRunToolCallBudget("   ")).toBe(400);
  });
  it("explicit 0 disables; positive integers pass through trimmed", () => {
    expect(parseRunToolCallBudget("0")).toBe(0);
    expect(parseRunToolCallBudget(" 42 ")).toBe(42);
  });
  it("any other invalid value is a boot error", () => {
    for (const value of ["-1", "1.5", "abc", "NaN", "Infinity"])
      expect(() => parseRunToolCallBudget(value)).toThrow(/RUN_TOOL_CALL_BUDGET/);
  });
});
