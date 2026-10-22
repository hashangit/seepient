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
    // Count-then-insert is only race-free under a serializable transaction:
    // under Read Committed two concurrent admissions can both observe
    // `current.length < budget` and both insert. The isolation level makes
    // Postgres abort one side (SQLSTATE P2034 / Prisma error code P2034);
    // one retry covers the transient case. Product dispatch is sequential
    // today, but the ledger must not DEPEND on that (gate-review P2).
    const attempt = (): Promise<{ count: number } | null> =>
      this.prisma.$transaction(
        async (tx) => {
          const admissionTx = tx as unknown as AdmissionTx;
          const current = await admissionTx.sharedBudgetAdmission.findMany({ where: { runId } });
          // Idempotent replay: an executionId already admitted IS admitted —
          // return success without a second record (exactly-one admission per
          // execution). The unique (runId, executionId) index backstops this
          // at the DB layer.
          if (current.some((r) => r.executionId === executionId)) return { count: 1 };
          if (current.length >= this.budget) return null;
          return admissionTx.sharedBudgetAdmission.createMany({
            data: [{ runId, executionId, callerKind }],
          });
        },
        { isolationLevel: "Serializable" },
      );
    let created: { count: number } | null = null;
    for (let tries = 0; tries < 2; tries += 1) {
      try {
        created = await attempt();
        break;
      } catch (error) {
        // Retry only Prisma's serialization-abort signature (error code P2034).
        if (
          tries === 1 ||
          typeof error !== "object" ||
          error === null ||
          !("code" in error) ||
          error.code !== "P2034"
        ) {
          throw error;
        }
      }
    }
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
