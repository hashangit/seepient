import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { LocalPolicyStore, GLOBAL_WORKSPACE_ID, computeWorkspaceId } from "../policy-store.js";
import { PersistedCapabilityLedger } from "../persisted-capability-ledger.js";
import { migrateLegacyGrants } from "../grant-migration.js";
import { buildActionLifecycle } from "../action-lifecycle-factory.js";
import { ActionLifecycle } from "../action-lifecycle.js";
import { PolicyEngine } from "../policy-engine.js";
import { LocalAuditStore } from "../audit-recorder.js";
import type { Capability, CapabilitySet, ApprovalBroker } from "../../../foundations/contracts/permission-policy.js";

const NOOP_BROKER: ApprovalBroker = {
  mode: "inline",
  request: async (req) => ({
    approved: false,
    requestId: req.requestId,
    actionDigest: req.actionDigest,
    actorId: "test-broker",
    reason: "cancelled",
    decidedAt: Date.now(),
  }),
};

const FAKE_BOUNDARY = {
  capabilities: { backend: "in-memory" },
  execute: async () => ({
    state: "succeeded" as const,
    result: { output: "ok", success: true },
    evidence: {
      backend: "in-memory",
      actionDigest: "fake",
      executorId: "fake",
      operationKind: "none",
    },
  }),
  dispose: async () => {},
};

describe("Spec 022 US3: Principal-Scoped Permission State (T023-T026)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "seepient-scoped-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  describe("T023: Stamp grant writes", () => {
    it("approve-and-persist under principal A stamps principalId on stored capabilities", async () => {
      const policyDir = path.join(tempDir, "policies");
      const store = new LocalPolicyStore({ root: policyDir });
      const auditStore = new LocalAuditStore({ root: path.join(tempDir, "audit") });

      const lifecycle = new ActionLifecycle({
        policy: new PolicyEngine("digest"),
        policyContext: {
          deploymentCeiling: { version: 1, capabilities: [{ kind: "commit-file", path: "/p/a.txt" }] },
          principalPolicy: { version: 1, capabilities: [{ kind: "commit-file", path: "/p/a.txt" }] },
          runtimeBaseline: { version: 1, capabilities: [{ kind: "commit-file", path: "/p/a.txt" }] },
          activeCapabilities: { version: 1, capabilities: [] },
          immutableDenies: [],
          approvalMode: "manual",
          interaction: { mode: "inline" },
          workspaceRoot: "/p",
          workspaceId: "ws-t023",
          trustedHostAllowlist: ["use_skill"],
          backendCapabilities: {
            backend: "local-native",
            capabilityKinds: ["commit-file"],
            exactCommit: true,
            hostFilteredEgress: true,
            environmentIsolation: true,
            supportedOperationKinds: ["none", "commit-files"],
          },
        },
        broker: {
          mode: "inline",
          request: async (req) => ({
            approved: true,
            requestId: req.requestId,
            actionDigest: req.actionDigest,
            optionId: req.approvalOptions[0]?.optionId ?? "opt-1",
            actorId: "tenant-a",
            decidedAt: Date.now(),
            lifetime: "project",
          }),
        },
        boundary: FAKE_BOUNDARY as any,
        audit: auditStore,
        activeCapabilities: { capabilities: [] },
        policyStore: store,
        workspaceId: "ws-t023",
        terminalOutbox: { enqueue: async () => {} } as any,
      });

      const action = {
        version: 1,
        actionId: "act-1",
        runId: "run-1",
        toolCallId: "c1",
        toolName: "write_file",
        principalId: "tenant-a",
        actionDigest: "d1",
        argsDigest: "args1",
        risk: "edit",
        effects: [
          {
            kind: "filesystem-write",
            targets: [
              {
                target: {
                  canonicalPath: "/p/a.txt",
                  canonicalParent: "/p",
                  basename: "a.txt",
                  exists: false,
                  finalSymlink: false,
                },
                mode: "create",
              },
            ],
          },
        ],
        display: {
          title: "write",
          summary: "/p/a.txt",
          canonicalTargets: ["/p/a.txt"],
          effects: ["filesystem-write"],
        },
        operation: {
          kind: "commit-files",
          commits: [
            {
              destination: {
                canonicalPath: "/p/a.txt",
                canonicalParent: "/p",
                basename: "a.txt",
                exists: false,
                finalSymlink: false,
              },
              content: {
                artifactId: "art1",
                sha256: "x",
                byteLength: 4,
                mediaType: "text/plain",
              },
            },
          ],
        },
        requiredCapabilities: [{ kind: "commit-file", path: "/p/a.txt" }],
      };

      const result = await lifecycle.run(action as any);
      expect(result.outcome.state).toBe("succeeded");

      const snap = await store.read("ws-t023");
      expect(snap.policy.capabilities.length).toBeGreaterThan(0);
      for (const cap of snap.policy.capabilities) {
        expect(cap.principalId).toBe("tenant-a");
      }
    });

    it("migration write path stamps principalId onto converted capabilities", () => {
      const outcome = migrateLegacyGrants(
        [
          {
            id: "g1",
            tool: "write_file",
            pattern: "/p/file.txt",
            scope: "project",
            createdAt: 1000,
          },
        ],
        { principalId: "tenant-migration" },
      );

      expect(outcome.capabilities.capabilities).toHaveLength(1);
      expect(outcome.capabilities.capabilities[0].principalId).toBe("tenant-migration");
      expect(outcome.capabilities.capabilities[0]).toEqual({
        kind: "commit-file",
        path: "/p/file.txt",
        principalId: "tenant-migration",
      });
    });

    it("reconciliation write path stamps principalId on newly-defaulted kinds", async () => {
      const policyDir = path.join(tempDir, "policies");
      const store = new LocalPolicyStore({ root: policyDir });
      const workspaceRoot = path.join(tempDir, "workspace");
      const workspaceId = computeWorkspaceId(workspaceRoot);

      // Pre-ceiling snapshot
      await store.compareAndSet(
        workspaceId,
        0,
        {
          version: 1,
          capabilities: [{ kind: "process", principalId: "tenant-recon" }],
        },
        { kind: "human", authorityId: "tenant-recon", authenticatedBy: "test" },
      );

      // Strip ceilingVersion to simulate legacy snapshot
      const file = path.join(policyDir, `${workspaceId}.json`);
      const raw = JSON.parse(await fs.readFile(file, "utf8"));
      delete raw.ceilingVersion;
      await fs.writeFile(file, JSON.stringify(raw), "utf8");

      await buildActionLifecycle({
        principalId: "tenant-recon",
        runId: "run-recon",
        workspaceRoot,
        approvalBroker: NOOP_BROKER,
        executionBoundary: FAKE_BOUNDARY as any,
        policyStore: store,
        auditRoot: path.join(tempDir, "audit"),
      });

      const updated = await store.read(workspaceId);
      const networkCap = updated.policy.capabilities.find((c) => c.kind === "network-destination");
      expect(networkCap).toBeDefined();
      expect(networkCap?.principalId).toBe("tenant-recon");
    });
  });

  describe("T024: Filter grant reads matrix", () => {
    it("unit matrix: {stamped A, stamped B, unstamped} x {A reads, B reads, single-default reads}", async () => {
      const policyDir = path.join(tempDir, "policies");
      const store = new LocalPolicyStore({ root: policyDir });
      const ws = "ws-matrix";

      const capA: Capability = { kind: "process", executable: "/bin/echo", principalId: "tenant-a" };
      const capB: Capability = { kind: "process", executable: "/bin/ls", principalId: "tenant-b" };
      const capLegacy: Capability = { kind: "process", executable: "/bin/pwd" };

      await store.compareAndSet(
        ws,
        0,
        { version: 1, capabilities: [capA, capB, capLegacy] },
        { kind: "human", authorityId: "admin", authenticatedBy: "test" },
      );

      // 1. A reads (multi mode): sees stamped A ONLY
      const snapA = await store.read(ws, { principalId: "tenant-a", tenancyMode: "multi" });
      expect(snapA.policy.capabilities).toEqual([capA]);

      // 2. B reads (multi mode): sees stamped B ONLY
      const snapB = await store.read(ws, { principalId: "tenant-b", tenancyMode: "multi" });
      expect(snapB.policy.capabilities).toEqual([capB]);

      // 3. Single-default reads: sees unstamped legacy entries
      const snapSingle = await store.read(ws, { principalId: "sdk-user" });
      expect(snapSingle.policy.capabilities).toEqual([capLegacy]);

      const snapSingleExplicit = await store.read(ws, { principalId: "agent-user", tenancyMode: "single" });
      expect(snapSingleExplicit.policy.capabilities).toEqual([capLegacy]);
    });

    it("legacy file fixture without principal stamps serves single-mode default principal", async () => {
      const policyDir = path.join(tempDir, "policies");
      const store = new LocalPolicyStore({ root: policyDir });
      const ws = "ws-legacy-fixture";

      const legacyCaps: Capability[] = [
        { kind: "read-root", root: "/legacy/root" },
        { kind: "write-root", root: "/legacy/root" },
        { kind: "commit-file", path: "/legacy/root/app.ts" },
      ];

      await store.compareAndSet(
        ws,
        0,
        { version: 1, capabilities: legacyCaps },
        { kind: "human", authorityId: "legacy-admin", authenticatedBy: "cli" },
      );

      // Single-mode default principal sees all legacy capabilities
      const snap = await store.read(ws, { principalId: "sdk-user" });
      expect(snap.policy.capabilities).toEqual(legacyCaps);

      // Multi-mode tenant principal sees none of the unstamped capabilities
      const snapTenant = await store.read(ws, { principalId: "tenant-fresh", tenancyMode: "multi" });
      expect(snapTenant.policy.capabilities).toEqual([]);
    });
  });

  describe("T025: Global merge and operator baseline", () => {
    it("global.json merge is principal-filtered and operatorBaseline applies unstamped to all", async () => {
      const policyDir = path.join(tempDir, "policies");
      const store = new LocalPolicyStore({ root: policyDir });

      // In global.json, store a grant stamped with tenant-a
      await store.compareAndSet(
        GLOBAL_WORKSPACE_ID,
        0,
        {
          version: 1,
          capabilities: [
            { kind: "commit-file", path: "/global/a.txt", principalId: "tenant-a" },
            { kind: "commit-file", path: "/global/b.txt", principalId: "tenant-b" },
          ],
        },
        { kind: "human", authorityId: "admin", authenticatedBy: "test" },
      );

      const operatorBaseline: CapabilitySet = {
        version: 1,
        capabilities: [{ kind: "process", executable: "/usr/bin/security-probe" }],
      };

      // Tenant A lifecycle
      const lifecycleA = await buildActionLifecycle({
        principalId: "tenant-a",
        runId: "run-a",
        workspaceRoot: "/p",
        approvalBroker: NOOP_BROKER,
        executionBoundary: FAKE_BOUNDARY as any,
        policyStore: store,
        auditRoot: path.join(tempDir, "audit"),
        operatorBaseline,
        deploymentCeiling: { version: 1, capabilities: [] },
        principalPolicy: { version: 1, capabilities: [] },
        tenancyMode: "multi",
      });

      // Tenant B lifecycle
      const lifecycleB = await buildActionLifecycle({
        principalId: "tenant-b",
        runId: "run-b",
        workspaceRoot: "/p",
        approvalBroker: NOOP_BROKER,
        executionBoundary: FAKE_BOUNDARY as any,
        policyStore: store,
        auditRoot: path.join(tempDir, "audit"),
        operatorBaseline,
        deploymentCeiling: { version: 1, capabilities: [] },
        principalPolicy: { version: 1, capabilities: [] },
        tenancyMode: "multi",
      });

      const capsA = lifecycleA.policyContext.principalPolicy.capabilities;
      const capsB = lifecycleB.policyContext.principalPolicy.capabilities;

      // Both contain operator baseline
      expect(capsA.some((c) => c.kind === "process" && (c as any).executable === "/usr/bin/security-probe")).toBe(true);
      expect(capsB.some((c) => c.kind === "process" && (c as any).executable === "/usr/bin/security-probe")).toBe(true);

      // Tenant A has /global/a.txt, but NOT /global/b.txt
      expect(capsA.some((c) => c.kind === "commit-file" && (c as any).path === "/global/a.txt")).toBe(true);
      expect(capsA.some((c) => c.kind === "commit-file" && (c as any).path === "/global/b.txt")).toBe(false);

      // Tenant B has /global/b.txt, but NOT /global/a.txt
      expect(capsB.some((c) => c.kind === "commit-file" && (c as any).path === "/global/b.txt")).toBe(true);
      expect(capsB.some((c) => c.kind === "commit-file" && (c as any).path === "/global/a.txt")).toBe(false);
    });
  });

  describe("T026: Scoped capability ledger", () => {
    it("local layout shows per-principal directories and independent consumption", async () => {
      const capsDir = path.join(tempDir, "caps");
      const ledger = new PersistedCapabilityLedger({ root: capsDir });

      const digest = "action-digest-t026";
      const consumedA = await ledger.consume("env-1", digest, { principalId: "tenant-a" });
      expect(consumedA).toBe(true);

      const consumedB = await ledger.consume("env-2", digest, { principalId: "tenant-b" });
      expect(consumedB).toBe(true);

      // Verify on-disk layout: caps/tenant-a/ledger.ndjson and caps/tenant-b/ledger.ndjson
      const statA = await fs.stat(path.join(capsDir, "tenant-a", "ledger.ndjson"));
      expect(statA.isFile()).toBe(true);

      const statB = await fs.stat(path.join(capsDir, "tenant-b", "ledger.ndjson"));
      expect(statB.isFile()).toBe(true);

      // Tenant A consuming again fails (replay)
      const consumedA2 = await ledger.consume("env-3", digest, { principalId: "tenant-a" });
      expect(consumedA2).toBe(false);
    });

    it("revocations for default or tenant A do not leak to tenant B", async () => {
      const capsDir = path.join(tempDir, "caps");
      const ledger = new PersistedCapabilityLedger({ root: capsDir });

      await ledger.revoke({ runId: "run-default" }, { principalId: "default" });
      await ledger.revoke({ sessionId: "session-default" }, { principalId: "default" });

      await ledger.revoke({ runId: "run-a" }, { principalId: "tenant-a" });
      await ledger.revoke({ sessionId: "session-a" }, { principalId: "tenant-a" });

      // Tenant A observes its own revocations
      expect(ledger.isRunRevoked("run-a", { principalId: "tenant-a" })).toBe(true);
      expect(ledger.isSessionRevoked("session-a", { principalId: "tenant-a" })).toBe(true);

      // Tenant B does not inherit default or tenant A revocations
      expect(ledger.isRunRevoked("run-default", { principalId: "tenant-b" })).toBe(false);
      expect(ledger.isSessionRevoked("session-default", { principalId: "tenant-b" })).toBe(false);
      expect(ledger.isRunRevoked("run-a", { principalId: "tenant-b" })).toBe(false);
      expect(ledger.isSessionRevoked("session-a", { principalId: "tenant-b" })).toBe(false);
    });
  });
});
