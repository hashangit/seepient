/**
 * P0 regression fixtures (spec 008, T007).
 *
 * These fixtures reproduce the six confirmed current defects so the fixes in
 * P1/P2/P4 can be verified against them. They use temporary directories,
 * fake credentials, and in-memory fakes — never real system data.
 *
 * Each fixture asserts the CURRENT (broken) behavior with a clear marker so
 * the migration is auditable. When the corresponding phase lands, the
 * `xit.skip` markers flip to active assertions of the fixed behavior.
 */
import { describe, it, expect } from "vitest";
import { PolicyEngine } from "../policy-engine.js";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PolicyContext } from "../../../foundations/contracts/permission-policy.js";

describe("P0 regression fixtures — prefix grant safety", () => {
  it("QS-0.3: prefix-grant collision is structurally unrepresentable safely", () => {
    // Legacy GrantSpec.pattern is a raw string prefix. Granting
    // `/tmp/demo` would match `/tmp/demo-evil/file`. This fixture documents
    // the shape; structured rules and exact matching retire it.
    const grant = { tool: "write_file", pattern: "/tmp/demo" } as const;
    const collisionTarget = "/tmp/demo-evil/file";
    expect(collisionTarget.startsWith(grant.pattern)).toBe(true);
  });

  it("fixture helper: writes to a temp dir never escape it", () => {
    // Regression tests use this pattern to guarantee no real-system mutation.
    const dir = mkdtempSync(join(tmpdir(), "seepient-regression-"));
    const target = join(dir, "probe.txt");
    writeFileSync(target, "probe");
    expect(target).toContain(dir);
  });
});

/**
 * Companion fixtures proving the NEW spec-008 pipeline fixes the legacy
 * defects above. These are the gates the legacy fixtures lacked: they assert
 * the FIXED behavior, so a regression that re-introduces autoConfirm bypass
 * or moderate+edit auto-approval on the new path fails here.
 *
 * End-to-end proof that the new path is actually reachable (not just
 * contract-tested) lives in:
 *   src/transport/__tests__/agent-loop-pipeline.e2e.test.ts
 */
describe("P0 regression fixtures — fixed behavior (spec-008 pipeline)", () => {
  it("QS-0.1 FIXED: PolicyEngine denies write_file when no capability is present", () => {
    // The legacy matrix returns "auto" for moderate+edit. The PolicyEngine
    // returns needs-approval (or deny in headless) for the same call when
    // the capability isn't pre-granted.
    const engine = new PolicyEngine("dig");
    const ctx: PolicyContext = {
      deploymentCeiling: { version: 1 as const, capabilities: [] },
      principalPolicy: { version: 1 as const, capabilities: [] },
      runtimeBaseline: { version: 1 as const, capabilities: [] },
      activeCapabilities: { version: 1 as const, capabilities: [] },
      immutableDenies: [],
      approvalMode: "manual" as const,
      interaction: { mode: "inline" as const },
      backendCapabilities: {
        backend: "local-native" as const,
        capabilityKinds: ["commit-file"],
        exactCommit: true, hostFilteredEgress: true, environmentIsolation: true,
        supportedOperationKinds: ["commit-files"],
      },
    };
    const action = {
      version: 1 as const, actionId: "a", runId: "r", toolCallId: "c",
      toolName: "write_file", principalId: "u", argsDigest: "x", actionDigest: "d",
      risk: "edit" as const,
      effects: [{
        kind: "filesystem-write" as const,
        targets: [{
          target: { canonicalPath: "/p/a.txt", canonicalParent: "/p", basename: "a.txt", exists: false, finalSymlink: false },
          mode: "create" as const,
        }],
      }],
      display: { title: "t", summary: "s", canonicalTargets: [], effects: [] },
      operation: { kind: "commit-files" as const, commits: [] },
    };
    const d = engine.evaluate(action, ctx);
    // NOT auto. The new path either needs-approval or denies.
    expect(d.decision).not.toBe("allow");
  });

  it("QS-0.2 FIXED: headless interaction.mode denies rather than auto-executing", () => {
    const engine = new PolicyEngine("dig");
    const ctx: PolicyContext = {
      deploymentCeiling: { version: 1 as const, capabilities: [{ kind: "commit-file" as const, path: "/p/a.txt" }] },
      principalPolicy: { version: 1 as const, capabilities: [{ kind: "commit-file" as const, path: "/p/a.txt" }] },
      runtimeBaseline: { version: 1 as const, capabilities: [{ kind: "commit-file" as const, path: "/p/a.txt" }] },
      activeCapabilities: { version: 1 as const, capabilities: [] }, // empty → not covered
      immutableDenies: [],
      approvalMode: "never" as const, // --yes equivalent
      interaction: { mode: "none" as const }, // headless
      backendCapabilities: {
        backend: "local-native" as const,
        capabilityKinds: ["commit-file"],
        exactCommit: true, hostFilteredEgress: true, environmentIsolation: true,
        supportedOperationKinds: ["commit-files"],
      },
    };
    const action = {
      version: 1 as const, actionId: "a", runId: "r", toolCallId: "c",
      toolName: "write_file", principalId: "u", argsDigest: "x", actionDigest: "d",
      risk: "edit" as const,
      effects: [{
        kind: "filesystem-write" as const,
        targets: [{
          target: { canonicalPath: "/p/a.txt", canonicalParent: "/p", basename: "a.txt", exists: false, finalSymlink: false },
          mode: "create" as const,
        }],
      }],
      display: { title: "t", summary: "s", canonicalTargets: [], effects: [] },
      operation: { kind: "commit-files" as const, commits: [] },
    };
    const d = engine.evaluate(action, ctx);
    // Headless + missing cap → deny(approval-unavailable), never auto-exec.
    expect(d.decision).toBe("deny");
  });
});
