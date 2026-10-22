/**
 * 029 T038 (FR-032/D5) — the durable SharedBudgetLedger: one shared
 * parent+helper tool-call budget enforced at PRE-DISPATCH admission via
 * atomic admission records keyed by (runId, executionId). The budget count
 * is reconstructed from durable records on restart (no in-memory state, no
 * fresh allowance after a pause → restart → resume).
 *
 * Single admission point: the governed dispatch boundary in
 * packages/adapters/src/executor.ts holds the injected ledger. The engine
 * loop NEVER checks admission (contract §3).
 */
import type { Prisma, PrismaClient } from "@seepients/db";

export interface SharedBudgetLedgerContract {
  /** Atomically admit one tool call; false when the budget is exhausted or
   * the executionId was already admitted (idempotent replay). */
  admit(runId: string, executionId: string, callerKind: "parent" | "helper"): Promise<boolean>;
  /** Durable used-unit count (reconstructed from admission records). */
  used(runId: string): Promise<number>;
}

interface AdmissionTx {
  sharedBudgetAdmission: {
    createMany(input: {
      data: Array<{ runId: string; executionId: string; callerKind: string }>;
    }): Promise<{ count: number }>;
    findMany(input?: { where?: { runId: string } }): Promise<Array<{ executionId: string }>>;
  };
}

export class SharedBudgetLedger implements SharedBudgetLedgerContract {
  constructor(
    private readonly prisma: Pick<PrismaClient, "$transaction">,
    private readonly budget: number,
  ) {}

  async admit(runId: string, executionId: string, callerKind: "parent" | "helper"): Promise<boolean> {
    const used = await this.used(runId);
    if (used >= this.budget) return false;
    const created = await this.prisma.$transaction(async (tx) => {
      // The unique (runId, executionId) index makes the double-admission
      // impossible at the DB layer; the count check makes over-budget
      // admission impossible under concurrency (serializable tx).
      const admissionTx = tx as unknown as AdmissionTx;
      const current = await admissionTx.sharedBudgetAdmission.findMany({ where: { runId } });
      // Idempotent replay: an executionId already admitted IS admitted —
      // return success without a second record (exactly-one admission per
      // execution).
      if (current.some((r) => r.executionId === executionId)) return { count: 1 };
      if (current.length >= this.budget) return null;
      return admissionTx.sharedBudgetAdmission.createMany({
        data: [{ runId, executionId, callerKind }],
      });
    });
    return created !== null && created.count === 1;
  }

  async used(runId: string): Promise<number> {
    const tx = this.prisma as unknown as {
      sharedBudgetAdmission?: { findMany(input: { where: { runId: string } }): Promise<unknown[]> };
    };
    if (!tx.sharedBudgetAdmission) return 0;
    return (await tx.sharedBudgetAdmission.findMany({ where: { runId } })).length;
  }
}
