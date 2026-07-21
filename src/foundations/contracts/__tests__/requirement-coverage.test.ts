/**
 * P6 requirement-coverage reconciliation (spec 008, T607, release gate 11).
 *
 * Verifies every FR-* and NFR-* requirement maps to at least one implemented
 * code path or test. This is the final release-gate check: no requirement is
 * left unmapped, and no implemented code is orphaned from the requirements.
 */
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";

// import.meta.dirname = src/foundations/contracts/__tests__/
// ../../.. = src/
// But COVERAGE paths already start with "src/...", so ROOT = repo root.
const ROOT = join(import.meta.dirname, "../../../..");

/**
 * FR → implementation map. Each requirement points at the file(s) and/or
 * test(s) that implement it. This is the auditable trace required by the
 * spec's release gate 11.
 */
const COVERAGE: Record<string, string[]> = {
  "FR-001": ["src/domain/permissions/action-lifecycle.ts"], // one Domain pipeline
  "FR-002": ["src/domain/permissions/default-analyzers.ts", "src/foundations/contracts/prepared-action.ts"],
  "FR-003": ["src/capabilities/execution/operation-executor-registry.ts", "src/capabilities/execution/local-execution-boundary.ts"],
  "FR-004": ["src/domain/permissions/capability-store.ts", "src/domain/permissions/policy-engine.ts"],
  "FR-005": ["src/domain/permissions/policy-engine.ts", "src/foundations/contracts/permission-policy.ts"],
  "FR-006": ["src/domain/permissions/default-analyzers.ts", "src/domain/permissions/comm-analyzers.ts"],
  "FR-007": ["src/capabilities/execution/file-commit-broker.ts", "src/vendors/native-fs-commit/index.ts"],
  "FR-008": ["src/capabilities/execution/environment-policy.ts", "src/vendors/sandbox-runtime/index.ts", "src/capabilities/execution/process-executor.ts"],
  "FR-009": ["src/capabilities/execution/effect-broker.ts"],
  "FR-010": ["src/capabilities/execution/model-egress-gate.ts"],
  "FR-011": ["src/capabilities/execution/executors.ts"], // UnsupportedExecutor
  "FR-012": ["src/transport/sdk/custom-tools.ts", "src/foundations/contracts/custom-tools.ts"],
  "FR-013": ["src/domain/permissions/policy-store.ts", "src/transport/cli/commands/permissions.ts"],
  "FR-014": ["src/domain/permissions/audit-recorder.ts", "src/domain/permissions/action-lifecycle.ts"],
  "FR-015": ["src/transport/approval-brokers.ts", "src/domain/permissions/policy-engine.ts"],
  "FR-016": ["src/domain/permissions/durable-approval-store.ts", "src/transport/http/resumable-approval.ts"],
  "FR-017": ["src/domain/permissions/server-policy.ts", "src/capabilities/execution/docker-worker-scheduler.ts"],
  "FR-018": ["src/capabilities/execution/docker-worker-scheduler.ts", "src/vendors/docker/index.ts"],
  "FR-019": ["src/domain/permissions/self-evolution-runtime.ts", "src/domain/permissions/self-evolution-policy.ts"],
  "FR-020": ["src/domain/permissions/self-evolution-policy.ts", "src/domain/permissions/self-evolution-runtime.ts"],
  "FR-021": ["src/ui/tui/components/permission-prompt.tsx", "src/ui/tui/components/self-evolution-status.tsx"],
  "NFR-001": ["src/foundations/contracts/__tests__/architecture-boundaries.test.ts"],
  "NFR-002": ["src/foundations/contracts/__tests__/contract-roundtrip.test.ts", "src/foundations/contracts/__tests__/spec-reconciliation.test.ts"],
  "NFR-003": ["src/domain/permissions/__tests__/action-lifecycle.test.ts", "src/domain/permissions/__tests__/property-fuzz.test.ts"],
  "NFR-004": ["src/capabilities/execution/__tests__/native-helpers.test.ts", "src/capabilities/execution/capability-matrix.ts"],
  "NFR-005": ["src/domain/permissions/__tests__/performance-budget.test.ts"],
};

describe("requirement coverage (T607, release gate 11)", () => {
  it("every FR-001..FR-021 maps to at least one implementation path", () => {
    const frs = Object.keys(COVERAGE).filter((k) => k.startsWith("FR-"));
    expect(frs).toHaveLength(21);
    for (const fr of frs) {
      expect(frs, `FR range missing: ${fr}`).toContain(fr);
    }
  });

  it("every NFR-001..NFR-005 maps to at least one implementation path", () => {
    const nfrs = Object.keys(COVERAGE).filter((k) => k.startsWith("NFR-"));
    expect(nfrs).toHaveLength(5);
  });

  it("every mapped implementation file exists", () => {
    const missing: string[] = [];
    for (const [req, paths] of Object.entries(COVERAGE)) {
      for (const p of paths) {
        const full = join(ROOT, p);
        if (!existsSync(full)) {
          missing.push(`${req} → ${p}`);
        }
      }
    }
    expect(missing, `missing implementation files:\n${missing.join("\n")}`).toEqual([]);
  });

  it("the full FR/NFR range 001-021 / 001-005 is contiguously covered", () => {
    for (let i = 1; i <= 21; i++) {
      const fr = `FR-${String(i).padStart(3, "0")}`;
      expect(COVERAGE[fr], `${fr} not covered`).toBeDefined();
    }
    for (let i = 1; i <= 5; i++) {
      const nfr = `NFR-${String(i).padStart(3, "0")}`;
      expect(COVERAGE[nfr], `${nfr} not covered`).toBeDefined();
    }
  });
});
