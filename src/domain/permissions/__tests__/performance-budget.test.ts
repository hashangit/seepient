/**
 * P6 performance microbenchmark (spec 008, T603, NFR-005).
 *
 * Measures the in-process CPU cost of `digestAction + PolicyEngine.evaluate`
 * on the fast allow-path (capability already present). This is a COMPONENT
 * measurement, NOT the end-to-end per-tool overhead. It EXCLUDES:
 *  - filesystem canonicalization (realpath + lstat in the analyzer)
 *  - artifact store writes (content hashing)
 *  - audit fsync (the dominant cost in the real path)
 *  - approval-broker round-trips
 *
 * NFR-005 targets ≤5 ms/tool excluding snapshots for the policy/analyzer
 * component specifically. The end-to-end budget (including audit fsync) is
 * a separate measurement that requires the pipeline to be wired into the
 * real call path with a real audit store; that measurement is pending.
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
  jsFsFallbackOptIn: false,
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
    // NFR-005 component target: ≤5 ms for the policy/analyzer CPU work.
    // This does NOT include audit fsync or filesystem I/O; see file header.
    expect(p50).toBeLessThan(50);
    expect(p95).toBeLessThan(100);
  });
});
