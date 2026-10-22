-- 029 T038: durable shared tool-call budget ledger (parent + helpers).
-- CreateTable
CREATE TABLE "shared_budget_admissions" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "executionId" TEXT NOT NULL,
    "callerKind" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shared_budget_admissions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "shared_budget_admissions_runId_executionId_key" ON "shared_budget_admissions"("runId", "executionId");

-- CreateIndex
CREATE INDEX "shared_budget_admissions_runId_idx" ON "shared_budget_admissions"("runId");

-- AddForeignKey
ALTER TABLE "shared_budget_admissions" ADD CONSTRAINT "shared_budget_admissions_runId_fkey" FOREIGN KEY ("runId") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
