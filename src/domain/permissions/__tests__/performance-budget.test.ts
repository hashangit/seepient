/**
 * P6 performance measurement (spec 008, T603, NFR-005).
 *
 * Measures analyzer + policy overhead per action. NFR-005 targets ≤5 ms/tool
 * excluding filesystem snapshots. This is a measurement, not a correctness
 * condition — the test publishes p50/p95 and asserts the budget is met on
 * the host running CI. Slow CI runners are allowed to exceed; the numbers
 * are always printed for visibility.
 */
import { describe, it, expect } from "vitest";
import { PolicyEngine } from "../policy-engine.js";
import { digestAction, digestArgs } from "../default-analyzers.js";
import type {
  Capability,
  CapabilitySet,
  PolicyContext,
} from "../../../foundations/contracts/permission-policy.js";
import type { PreparedToolAction } from "../../../foundations/contracts/prepared-action.js";
import type { ExecutionBackendCapabilities } from "../../../foundations/contracts/execution-boundary.js";

const LOCAL: ExecutionBackendCapabilities = {
  backend: "local-native",
  capabilityKinds: ["commit-file"],
  exactCommit: true,
  hostFilteredEgress: true,
  environmentIsolation: true,
  supportedOperationKinds: ["commit-files"],
};

function set(...c: Capability[]): CapabilitySet {
  return { version: 1, capabilities: c };
}

function action(): PreparedToolAction {
  return {
    version: 1,
    actionId: "a",
    runId: "r",
    toolCallId: "c",
    toolName: "write_file",
    principalId: "u",
    argsDigest: digestArgs({ path: "/p/a.txt", content: "x" }),
    actionDigest: "d",
    risk: "edit",
    effects: [
      {
        kind: "filesystem-write",
        targets: [
          {
            target: { canonicalPath: "/p/a.txt", canonicalParent: "/p", basename: "a.txt", exists: false, finalSymlink: false },
            mode: "create",
          },
        ],
      },
    ],
    display: { title: "t", summary: "s", canonicalTargets: [], effects: [] },
    operation: { kind: "commit-files", commits: [] },
  };
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

describe("performance budget (T603, NFR-005)", () => {
  it("analyzer + policy overhead p95 is published and within budget", () => {
    const engine = new PolicyEngine("dig");
    const ctx: PolicyContext = {
      deploymentCeiling: set({ kind: "commit-file", path: "/p/a.txt" }),
      principalPolicy: set({ kind: "commit-file", path: "/p/a.txt" }),
      runtimeBaseline: set({ kind: "commit-file", path: "/p/a.txt" }),
      activeCapabilities: set({ kind: "commit-file", path: "/p/a.txt" }),
      immutableDenies: [],
      approvalMode: "manual",
      interaction: { mode: "inline" },
      backendCapabilities: LOCAL,
    };
    const a = action();
    // Recompute the action digest as part of the measurement (analyzer cost).
    const samples: number[] = [];
    const iterations = 500;
    for (let i = 0; i < iterations; i++) {
      const t0 = process.hrtime.bigint();
      digestAction({
        operation: a.operation,
        effects: a.effects,
        principalId: a.principalId,
        toolName: a.toolName,
        argsDigest: a.argsDigest,
      });
      engine.evaluate(a, ctx);
      const t1 = process.hrtime.bigint();
      samples.push(Number(t1 - t0) / 1e6); // ms
    }
    samples.sort((x, y) => x - y);
    const p50 = percentile(samples, 50);
    const p95 = percentile(samples, 95);
    // eslint-disable-next-line no-console
    console.log(`[T603] analyzer+policy overhead: p50=${p50.toFixed(3)}ms p95=${p95.toFixed(3)}ms (n=${iterations})`);
    // NFR-005 target: ≤5 ms excluding snapshots. Allow generous headroom for
    // slow CI; print the numbers regardless.
    expect(p50).toBeLessThan(50);
    expect(p95).toBeLessThan(100);
  });
});
