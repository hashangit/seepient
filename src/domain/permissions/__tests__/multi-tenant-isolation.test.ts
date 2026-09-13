/**
 * Spec 022 — Multi-Tenant Isolation Matrix (contracts/isolation-harness.md).
 *
 * Asserts all 8 dimensions of multi-tenant isolation across two tenants in
 * one Node.js process:
 *   Dim 1: Tool visibility
 *   Dim 2: Tool resolution
 *   Dim 3: Tool execution & authority
 *   Dim 4: Credentials & runtime requirement
 *   Dim 5: Persisted grants & operator baseline
 *   Dim 6: Capability ledger
 *   Dim 7: Sessions & skills isolation
 *   Dim 8: Ambient I/O zero-write guarantee
 *
 * Split into two blocks:
 *   - Registry block (Dims 1–3): tests tool isolation directly
 *   - Tenancy block (Dims 4–8): tests tenancy-mode fail-closed rules
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from "vitest";
import { mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as http from "node:http";
import { LocalPolicyStore, computeWorkspaceId } from "../policy-store.js";
import { PersistedCapabilityLedger } from "../persisted-capability-ledger.js";
import { LocalAuditStore } from "../audit-recorder.js";
import { buildActionLifecycle } from "../action-lifecycle-factory.js";
import { validateTenancyCompleteness, SENTINEL_PRINCIPAL_IDS, TenancyStoreIncompleteError } from "../../tenancy/tenancy-mode.js";
import { PrincipalRequiredError } from "../../../foundations/errors.js";
import { InMemoryArtifactStore } from "../../../capabilities/execution/in-memory-artifact-store.js";
import type { ExecutionBoundary } from "../../../foundations/contracts/execution-boundary.js";
import type { ApprovalBroker } from "../../../foundations/contracts/permission-policy.js";
import { FilePersistenceBackend } from "../../sessions/session-store.js";
import { ProviderRuntime } from "../../providers/provider-runtime.js";

let createSeepient: any;
let askSeepient: any;
let createFakeRuntime: any;
let runSeepientServer: any;
let generateApiKey: any;

beforeAll(async () => {
  const sdk = await import("../../../transport/sdk/index.js");
  const server = await import("../../../transport/http/index.js");
  const auth = await import("../../../transport/auth/auth.js");
  runSeepientServer = server.runSeepientServer;
  generateApiKey = auth.generateApiKey;
  createSeepient = sdk.createSeepient;
  askSeepient = sdk.askSeepient;
  const fakes = await import("../../../transport/sdk/__tests__/helpers/fake-stores.js");
  createFakeRuntime = fakes.createFakeRuntime;
});
import { ProviderConfigStore } from "../../providers/config-store/provider-config-store.js";
import { CompositeCredentialStore } from "../../providers/credentials/composite-credential-store.js";
import { MemoryCredentialStore } from "../../providers/credentials/memory-credential-store.js";
import type { ToolModule, ToolDefinition } from "../../../foundations/contracts/tool.js";
import {
  resolveTools,
  ToolRegistry,
} from "../../tool-executor.js";
import { initializeSkillRegistry } from "../../../capabilities/skills/index.js";
import type { SkillSource } from "../../../foundations/contracts/skill-source.js";
import { runAgentLoop } from "../../agent-loop.js";
import { createMockRuntime } from "../../__tests__/test-doubles.js";

function createTenantTool(name: string): ToolModule {
  return {
    name,
    definition: {
      type: "function",
      function: {
        name,
        description: `Tenant tool ${name}`,
        parameters: {
          type: "object",
          properties: { input: { type: "string" } },
          required: [],
        },
      },
    },
    handler: async (args: Record<string, unknown>) => ({
      success: true,
      output: `executed ${name}: ${JSON.stringify(args)}`,
    }),
  };
}

describe("Spec 022 Multi-Tenant Isolation Matrix", () => {
  let sandboxHome: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    sandboxHome = mkdtempSync(join(tmpdir(), "seepient-sandbox-home-"));
    prevHome = process.env.HOME;
    process.env.HOME = sandboxHome;
    process.env.SEEPIENT_HOME = sandboxHome;
  });

  afterEach(() => {
    process.env.HOME = prevHome;
    delete process.env.SEEPIENT_HOME;
    try {
      rmSync(sandboxHome, { recursive: true, force: true });
    } catch {}
  });

  // ── Block 1: Registry Block (Dimensions 1–3) ──────────────────────────────
  describe("Block 1: Registry Block", () => {
    it("Dim 1: Tool visibility — Tenant A custom/MCP tools are absent from Tenant B toolDefs", async () => {
      const toolA = createTenantTool("tenant_a_tool");
      const registryA = new ToolRegistry();
      registryA.register(toolA);

      const registryB = new ToolRegistry();
      const defsB = registryB.definitions();
      expect(defsB.some((d: ToolDefinition) => d.function.name === "tenant_a_tool")).toBe(false);
    });

    it("Dim 2: Tool resolution — resolveTools resolves names only against own registry", async () => {
      const toolA = createTenantTool("tenant_a_scoped_tool");
      const registryA = new ToolRegistry();
      registryA.register(toolA);

      const registryB = new ToolRegistry();
      expect(() => resolveTools(["tenant_a_scoped_tool"], registryB)).toThrow(
        /Unknown tool|not found/i,
      );
    });

    it("Dim 3: Tool execution & authority — Tenant A tool cannot be executed by Tenant B", async () => {
      let executedA = false;
      const toolA: ToolModule = {
        name: "tenant_a_exec_tool",
        definition: {
          type: "function",
          function: {
            name: "tenant_a_exec_tool",
            description: "Tenant A executable tool",
            parameters: { type: "object", properties: {}, required: [] },
          },
        },
        handler: async () => {
          executedA = true;
          return { success: true, output: "tenant A executed" };
        },
      };

      const registryA = new ToolRegistry([toolA]);
      const registryB = new ToolRegistry();

      // Static check: registry B cannot find tool A
      expect(registryB.find("tenant_a_exec_tool")).toBeUndefined();

      // End-to-end execution check: model calls tenant A tool name in tenant B loop
      const runtime = createMockRuntime([
        {
          toolCalls: [
            {
              id: "call_a_in_b",
              name: "tenant_a_exec_tool",
              arguments: "{}",
            },
          ],
        },
        { text: "Done" },
      ]);

      const result = await runAgentLoop({
        runtime,
        messages: [{ id: "m1", role: "user", content: "call tenant a tool", timestamp: Date.now() }],
        toolDefs: [toolA.definition],
        toolRegistry: registryB,
        maxSteps: 3,
        autoConfirm: true,
      });

      // Tenant A handler was never executed
      expect(executedA).toBe(false);

      // Tool execution failed closed in Tenant B loop
      const toolStep = result.steps.find((s) => s.type === "tool_call");
      expect(toolStep).toBeDefined();
      expect((toolStep as any)?.toolCall?.result).toMatch(/HOST_TOOL_NOT_REGISTERED|not registered|denied|unknown/i);
    });
  });

  // ── Block 2: Tenancy Block (Dimensions 4–8) ───────────────────────────────
  describe("Block 2: Tenancy Block", () => {
    it("Dim 4: Credentials — multi mode without runtime throws TENANCY_RUNTIME_REQUIRED", async () => {
      await expect(
        createSeepient({
          tenancy: "multi",
          principalId: "tenant-dim",
        } as any),
      ).rejects.toThrowError(
        expect.objectContaining({
          code: "TENANCY_RUNTIME_REQUIRED",
        }),
      );
    });

    it("Dim 5: Grants — Tenant A stored grants do not authorize Tenant B (real LocalPolicyStore)", async () => {
      const policyDir = join(sandboxHome, "policies");
      const policyStore = new LocalPolicyStore({ root: policyDir });
      const workspaceId = "ws-shared-dim5";

      const capA = {
        kind: "process" as const,
        executable: "/bin/echo",
        principalId: "tenant-a",
      };
      const capB = {
        kind: "process" as const,
        executable: "/bin/ls",
        principalId: "tenant-b",
      };
      const capLegacy = {
        kind: "process" as const,
        executable: "/bin/pwd",
      };

      // Tenant A records a grant (along with B and an unstamped legacy grant on disk)
      await policyStore.compareAndSet(
        workspaceId,
        0,
        {
          version: 1,
          capabilities: [capA as any, capB as any, capLegacy as any],
        },
        { kind: "human", authorityId: "admin", authenticatedBy: "test" },
      );

      // Verify file exists on real disk
      expect(existsSync(join(policyDir, `${workspaceId}.json`))).toBe(true);

      // Tenant B reads policy under principal "tenant-b" in multi-mode: sees stamped B ONLY
      const snapB = await policyStore.read(workspaceId, { principalId: "tenant-b", tenancyMode: "multi" });
      expect(snapB.policy.capabilities).toEqual([capB]);
      expect(snapB.policy.capabilities.some((c: any) => c.principalId === "tenant-a")).toBe(false);
      expect(snapB.policy.capabilities.some((c: any) => !c.principalId)).toBe(false);

      // Tenant A reads policy under principal "tenant-a" in multi-mode: sees stamped A ONLY
      const snapA = await policyStore.read(workspaceId, { principalId: "tenant-a", tenancyMode: "multi" });
      expect(snapA.policy.capabilities).toEqual([capA]);
      expect(snapA.policy.capabilities.some((c: any) => c.principalId === "tenant-b")).toBe(false);

      // Single-mode default reads see unstamped legacy capabilities
      const snapSingle = await policyStore.read(workspaceId, { principalId: "sdk-user" });
      expect(snapSingle.policy.capabilities).toEqual([capLegacy]);
    });

    it("Dim 6: Ledger — Tenant A consuming digest D does not deny Tenant B consuming D (real PersistedCapabilityLedger)", async () => {
      const capsDir = join(sandboxHome, "caps");
      const ledger = new PersistedCapabilityLedger({ root: capsDir });
      const digest = "action-digest-123";

      // Tenant A consumes digest
      const consumedA = await ledger.consume("env-a", digest, { principalId: "tenant-a" });
      expect(consumedA).toBe(true);

      // Tenant B consumes identical digest independently
      const consumedB = await ledger.consume("env-b", digest, { principalId: "tenant-b" });
      expect(consumedB).toBe(true);

      // Tenant A consuming again fails (replay prevention)
      const consumedA2 = await ledger.consume("env-a2", digest, { principalId: "tenant-a" });
      expect(consumedA2).toBe(false);

      // Verify on-disk layout: per-principal ledger.ndjson files
      expect(existsSync(join(capsDir, "tenant-a", "ledger.ndjson"))).toBe(true);
      expect(existsSync(join(capsDir, "tenant-b", "ledger.ndjson"))).toBe(true);

      // Revocations isolation
      await ledger.revoke({ runId: "run-a" }, { principalId: "tenant-a" });
      expect(ledger.isRunRevoked("run-a", { principalId: "tenant-a" })).toBe(true);
      expect(ledger.isRunRevoked("run-a", { principalId: "tenant-b" })).toBe(false);
    });

    it("Dim 7: Sessions & skills — Session resume cross-principal fails with SESSION_OWNERSHIP_MISMATCH and multi mode skill catalogs isolate to injected sources", async () => {
      const backend = new FilePersistenceBackend(join(sandboxHome, "dim7-sessions"));
      const sessionId = "sess-tenant-isolation-1";

      // Tenant A creates and persists session
      await backend.save(sessionId, {
        id: sessionId,
        messages: [{ id: "m1", role: "user", content: "Hello from tenant A", timestamp: Date.now() }],
        principalId: "tenant-a",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      // Tenant B attempts to resume Tenant A's session
      await expect(
        createSeepient({
          sessionId,
          principalId: "tenant-b",
          persist: backend,
          tenancy: "single",
        } as any),
      ).rejects.toThrowError(
        expect.objectContaining({
          code: "SESSION_OWNERSHIP_MISMATCH",
        }),
      );

      // Skills scoping (QS-4):
      const sourceA: SkillSource = {
        list: async () => [
          {
            name: "tenant_a_skill",
            content: "---\nname: tenant_a_skill\ndescription: Tenant A specific skill\n---\nSkill content A",
            source: "tenant-a",
          },
        ],
      };

      const registryA = await initializeSkillRegistry("/tmp", {
        sources: [sourceA],
        tenancyMode: "multi",
      });
      const registryB = await initializeSkillRegistry("/tmp", {
        sources: [],
        tenancyMode: "multi",
      });

      expect(registryA.get("tenant_a_skill")).toBeDefined();
      expect(registryB.get("tenant_a_skill")).toBeUndefined();
      expect(registryB.getMetadata()).toEqual([]);
    });

    it("Dim 8: Ambient I/O — multi mode agent turn causes zero writes under $HOME/.seepient", async () => {
      const storeDir = mkdtempSync(join(tmpdir(), "seepient-real-stores-"));
      try {
        const audit = new LocalAuditStore({ root: join(storeDir, "audit") });
        const policy = new LocalPolicyStore({ root: join(storeDir, "policy") });
        const ledger = new PersistedCapabilityLedger({ root: join(storeDir, "ledger") });
        const config = new ProviderConfigStore(":memory:");
        const cred = new CompositeCredentialStore({
          memory: new MemoryCredentialStore(),
          primaryWriteStore: "memory",
        });
        const runtime = createFakeRuntime({
          configStore: config,
          credentialStore: cred,
          responses: [{ text: "response" }],
        });

        await askSeepient("Hello", {
          cwd: sandboxHome,
          tenancy: "multi",
          principalId: "tenant-dim",
          runtime,
          auditStore: audit,
          policyStore: policy,
          capabilityLedger: ledger,
          stateless: true,
        } as any);

        // Verify no files or directories were created anywhere in sandboxHome
        expect(readdirSync(sandboxHome)).toEqual([]);
        expect(existsSync(join(sandboxHome, ".seepient"))).toBe(false);
      } finally {
        try {
          rmSync(storeDir, { recursive: true, force: true });
        } catch {}
      }
    });

    it("Dim 8b: Fail-closed — multi mode with stateless: true but missing stores throws TENANCY_STORE_INCOMPLETE", async () => {
      const config = new ProviderConfigStore(":memory:");
      const cred = new CompositeCredentialStore({
        memory: new MemoryCredentialStore(),
        primaryWriteStore: "memory",
      });
      const runtime = createFakeRuntime({
        configStore: config,
        credentialStore: cred,
      });

      await expect(
        askSeepient("Hello", {
          cwd: sandboxHome,
          tenancy: "multi",
          principalId: "tenant-dim",
          runtime,
          stateless: true,
        } as any),
      ).rejects.toThrowError(
        expect.objectContaining({
          code: "TENANCY_STORE_INCOMPLETE",
        }),
      );

      expect(readdirSync(sandboxHome)).toEqual([]);
    });

    it("Dim 9: Server surface — two API keys over real HTTP assert grant invisibility, session ownership, and runtime provider isolation", async () => {
      const tempKeyPath = join(sandboxHome, "api-keys.json");
      process.env.SEEPIENT_API_KEYS_FILE = tempKeyPath;

      const keyEntry1 = generateApiKey(["agent:run", "agent:read", "provider:admin"], {
        filePath: tempKeyPath,
        label: "tenant-key-1",
      });
      const keyEntry2 = generateApiKey(["agent:run", "agent:read", "provider:admin"], {
        filePath: tempKeyPath,
        label: "tenant-key-2",
      });

      const serverPolicyDir = join(sandboxHome, "server-policies");
      const policyStore = new LocalPolicyStore({ root: serverPolicyDir });
      const auditStore = new LocalAuditStore({ root: join(sandboxHome, "server-audit") });
      const capabilityLedger = new PersistedCapabilityLedger({ root: join(sandboxHome, "server-caps") });
      const backend = new FilePersistenceBackend(join(sandboxHome, "server-sessions"));

      const sessionId = "session-key-1";
      await backend.save(sessionId, {
        id: sessionId,
        messages: [{ id: "m1", role: "user", content: "Hello from key 1", timestamp: Date.now() }],
        metadata: {
          apiKeyHash: keyEntry1.keyHash,
        },
        principalId: keyEntry1.keyHash,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const runtime = createFakeRuntime({
        responses: [
          { content: "Server response 1" },
          { content: "Server response 2" },
        ],
      });

      const server = await runSeepientServer({
        runtime,
        auditStore,
        policyStore,
        capabilityLedger,
        persist: backend,
        listen: false,
      });

      try {
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const addr = server.address() as { port: number };
        const port = addr.port;

        const wsKey1 = computeWorkspaceId(join(process.cwd(), ".seepient", "workspaces", keyEntry1.keyHash));
        const wsKey2 = computeWorkspaceId(join(process.cwd(), ".seepient", "workspaces", keyEntry2.keyHash));

        await policyStore.compareAndSet(
          wsKey1,
          0,
          {
            version: 1,
            capabilities: [
              { kind: "network-destination", scheme: "https", host: "key1-only.internal", principalId: keyEntry1.keyHash },
              { kind: "network-destination", scheme: "https", host: "legacy-unstamped.internal" },
            ],
          },
          { kind: "service", authorityId: "test-admin", authenticatedBy: "test" },
        );

        await policyStore.compareAndSet(
          wsKey2,
          0,
          {
            version: 1,
            capabilities: [
              { kind: "network-destination", scheme: "https", host: "key2-only.internal", principalId: keyEntry2.keyHash },
              { kind: "network-destination", scheme: "https", host: "legacy-unstamped.internal" },
            ],
          },
          { kind: "service", authorityId: "test-admin", authenticatedBy: "test" },
        );

        const readSpy = vi.spyOn(policyStore, "read");

        const sendHttp = (options: http.RequestOptions, body?: string) =>
          new Promise<{ status: number; body: string }>((resolve, reject) => {
            const req = http.request({ hostname: "127.0.0.1", port, ...options }, (res) => {
              let data = "";
              res.on("data", (chunk) => (data += chunk));
              res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
            });
            req.on("error", reject);
            if (body) req.write(body);
            req.end();
          });

        // ── (a) Stored grant invisibility ───────────────────────────────────
        const resChat1 = await sendHttp(
          {
            method: "POST",
            path: "/v1/chat",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${keyEntry1.rawKey}`,
            },
          },
          JSON.stringify({ message: "Hello from Key 1", sessionId: "session-key-1" }),
        );
        expect(resChat1.status).toBe(200);

        const resChat2 = await sendHttp(
          {
            method: "POST",
            path: "/v1/chat",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${keyEntry2.rawKey}`,
            },
          },
          JSON.stringify({ message: "Hello from Key 2" }),
        );
        expect(resChat2.status).toBe(200);

        const snap1 = await readSpy.mock.results.find((_, idx) => readSpy.mock.calls[idx][1]?.principalId === keyEntry1.keyHash)!.value;
        const snap2 = await readSpy.mock.results.find((_, idx) => readSpy.mock.calls[idx][1]?.principalId === keyEntry2.keyHash)!.value;

        // Key 1 sees key1-only, not legacy-unstamped, not key2-only
        expect(snap1.policy.capabilities.some((c: any) => c.host === "key1-only.internal")).toBe(true);
        expect(snap1.policy.capabilities.some((c: any) => c.host === "key2-only.internal")).toBe(false);
        expect(snap1.policy.capabilities.some((c: any) => c.host === "legacy-unstamped.internal")).toBe(false);

        // Key 2 sees key2-only, not legacy-unstamped, not key1-only
        expect(snap2.policy.capabilities.some((c: any) => c.host === "key2-only.internal")).toBe(true);
        expect(snap2.policy.capabilities.some((c: any) => c.host === "key1-only.internal")).toBe(false);
        expect(snap2.policy.capabilities.some((c: any) => c.host === "legacy-unstamped.internal")).toBe(false);

        // ── (b) Session ownership across keys ──────────────────────────────
        // GET with key2 on key1's session returns 404 (invisibility)
        const resGetSess = await sendHttp({
          method: "GET",
          path: "/v1/sessions/session-key-1",
          headers: {
            Authorization: `Bearer ${keyEntry2.rawKey}`,
          },
        });
        expect(resGetSess.status).toBe(404);

        // Under FR-012: POST with key2 using key1's sessionId creates an isolated session in key2's partition without hijacking key1
        const resHijack = await sendHttp(
          {
            method: "POST",
            path: "/v1/chat",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${keyEntry2.rawKey}`,
            },
          },
          JSON.stringify({ message: "Hijack attempt", sessionId: "session-key-1" }),
        );
        expect(resHijack.status).toBe(200);
        expect(JSON.parse(resHijack.body).sessionId).toBe("session-key-1");

        // ── (c) Provider mutations land on injected runtime only ───────────
        const resMutate = await sendHttp(
          {
            method: "PUT",
            path: "/v1/providers/test-provider",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${keyEntry1.rawKey}`,
              "If-Match": "*",
            },
          },
          JSON.stringify({ upstreamProvider: "openai", credential: { mode: "none" } }),
        );
        expect(resMutate.status).toBe(200);

        expect(existsSync(join(sandboxHome, ".seepient", "providers.json"))).toBe(false);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        delete process.env.SEEPIENT_API_KEYS_FILE;
      }
    });

    it("Dim 5b: covers() freshness filter — Tenant B existing stored grant does not suppress Tenant A project grant persistence", async () => {
      const policyDir = join(sandboxHome, "policies-dim5b");
      const policyStore = new LocalPolicyStore({ root: policyDir });
      const workspaceId = computeWorkspaceId(sandboxHome);

      // Pre-populate policy with a grant stamped for tenant-b
      await policyStore.compareAndSet(
        workspaceId,
        0,
        {
          version: 1,
          capabilities: [
            {
              kind: "process",
              executable: "/bin/echo",
              principalId: "tenant-b",
            },
          ],
        },
        { kind: "human", authorityId: "admin", authenticatedBy: "test" },
      );

      const auditStore = new LocalAuditStore({ root: join(sandboxHome, "audit-dim5b") });
      const ledger = new PersistedCapabilityLedger({ root: join(sandboxHome, "ledger-dim5b") });
      const testBoundary: ExecutionBoundary = {
        capabilities: {
          backend: "local-native",
          capabilityKinds: [
            "read-root",
            "write-root",
            "process",
            "model-egress",
          ],
          exactCommit: false,
          hostFilteredEgress: false,
          environmentIsolation: true,
          supportedOperationKinds: ["none", "process"],
        },
        execute: async (action) => ({
          state: "succeeded",
          result: { output: "ok", success: true },
          evidence: { backend: "local-native", actionDigest: action.actionDigest, executorId: "test", operationKind: "process" },
        }),
      };

      const projectBroker: ApprovalBroker = {
        mode: "inline",
        request: async (req) => {
          const choice = req.approvalChoices.find((c) => c.lifetime === "project") ?? req.approvalChoices[0];
          return {
            approved: true,
            requestId: req.requestId,
            actionDigest: req.actionDigest,
            actorId: "tenant-a-user",
            optionId: choice?.optionId ?? req.approvalOptions[0]?.optionId,
            lifetime: choice?.lifetime ?? "project",
            decidedAt: Date.now(),
          };
        },
      };

      const wired = await buildActionLifecycle({
        principalId: "tenant-a",
        tenancyMode: "multi",
        runId: "run-tenant-a",
        sessionId: "sess-tenant-a",
        workspaceRoot: sandboxHome,
        policyStore,
        auditStore,
        capabilityLedger: ledger,
        approvalBroker: projectBroker,
        executionBoundary: testBoundary,
        artifacts: new InMemoryArtifactStore(),
      });

      const action = await wired.analyzers.execute_shell_command(
        { command: "/bin/echo hello" },
        { ...wired.analysisContext, toolCallId: "call-tenant-a" },
      );

      const runResult = await wired.lifecycle.run(action);
      expect(runResult.outcome.state).toBe("succeeded");

      // Verify that tenant-a's grant was persisted and NOT suppressed by tenant-b's grant
      const snapA = await policyStore.read(workspaceId, { principalId: "tenant-a", tenancyMode: "multi" });
      expect(snapA.policy.capabilities.some((c) => c.kind === "process" && c.principalId === "tenant-a")).toBe(true);
    });

    it("Dim 8c: buildActionLifecycle throws TenancyStoreIncompleteError in multi mode if any store is missing", async () => {
      await expect(
        buildActionLifecycle({
          principalId: "tenant-x",
          tenancyMode: "multi",
          workspaceRoot: sandboxHome,
        } as any),
      ).rejects.toThrowError(TenancyStoreIncompleteError);
    });

    it("Dim 8d: validateTenancyCompleteness rejects sentinel principal IDs in multi mode", () => {
      for (const sentinel of SENTINEL_PRINCIPAL_IDS) {
        expect(() =>
          validateTenancyCompleteness("multi", {
            principalId: sentinel,
            runtime: {} as any,
            auditStore: {} as any,
            policyStore: {} as any,
            capabilityLedger: {} as any,
          }),
        ).toThrow(PrincipalRequiredError);
      }
    });

    it("Dim 8e: runAgentLoop throws PIPELINE_NOT_INITIALIZED in multi mode when wiredPipeline is omitted", async () => {
      const runtime = createMockRuntime([{ text: "hello" }]);
      await expect(
        runAgentLoop({
          runtime,
          messages: [{ id: "m1", role: "user", content: "hi", timestamp: Date.now() }],
          toolDefs: [],
          maxSteps: 3,
          tenancyMode: "multi",
        }),
      ).rejects.toThrow(/wiredPipeline is required in multi-tenant mode/);
    });

    it("SC-002 new case 1: default-boot composition boots isolated empty runtime with zero ambient composition", async () => {
      process.env.ANTHROPIC_API_KEY = "sk-ant-operator-ambient-key";
      process.env.OPENAI_API_KEY = "sk-proj-operator-ambient-key";

      const tempKeyPath = join(sandboxHome, "api-keys-default-boot.json");
      process.env.SEEPIENT_API_KEYS_FILE = tempKeyPath;

      const keyEntry = generateApiKey(["agent:run", "agent:read"], {
        filePath: tempKeyPath,
        label: "tenant-boot-key",
      });

      const server = await runSeepientServer({
        listen: false,
      });

      try {
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const addr = server.address() as { port: number };
        const port = addr.port;

        const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
          const req = http.request(
            {
              hostname: "127.0.0.1",
              port,
              path: "/v1/chat",
              method: "POST",
              headers: {
                Authorization: `Bearer ${keyEntry.rawKey}`,
                "Content-Type": "application/json",
              },
            },
            (resp) => {
              let body = "";
              resp.on("data", (chunk) => (body += chunk));
              resp.on("end", () => resolve({ status: resp.statusCode ?? 500, body }));
            },
          );
          req.on("error", reject);
          req.write(JSON.stringify({ message: "Hello", model: "anthropic/claude-3-haiku" }));
          req.end();
        });

        // The isolated server has no ambient provider credentials, so it must fail typed
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.body).not.toContain("sk-ant-operator-ambient-key");
        expect(res.body).not.toContain("sk-proj-operator-ambient-key");
      } finally {
        server.close();
        delete process.env.ANTHROPIC_API_KEY;
        delete process.env.OPENAI_API_KEY;
      }
    });

    it("SC-002 new case 2: post-inversion trap — new ProviderRuntime() composes zero ambient providers and sibling mutations are isolated", async () => {
      process.env.ANTHROPIC_API_KEY = "sk-ant-decoy-trap-key";
      process.env.OPENAI_API_KEY = "sk-proj-decoy-trap-key";

      try {
        const r1 = new ProviderRuntime();
        const r2 = new ProviderRuntime();

        expect(r1.isIsolated).toBe(true);
        expect(r2.isIsolated).toBe(true);

        const config1 = await r1.getConfig();
        const config2 = await r2.getConfig();

        // Must compose zero ambient providers from host env
        expect(Object.keys(config1.providers ?? {})).toHaveLength(0);
        expect(Object.keys(config2.providers ?? {})).toHaveLength(0);

        // Credential store must not resolve host env credentials through fallback
        const credStore1 = r1.getCredentialStore();
        expect(credStore1).toBeDefined();
        const credResult = await credStore1!.resolve({
          kind: "env",
          name: "OPENAI_API_KEY",
        });
        expect(await credResult?.isResolvable()).toBe(false);
        expect(() => credResult?.acquireLease()).toThrow(/CREDENTIAL_REQUIRED/);

        // Mutating r1 does not leak to r2
        const cfgStore1 = r1.getConfigStore() as any;
        if (cfgStore1?.addProvider) {
          await cfgStore1.addProvider("tenant-a-provider", {
            adapter: "pi-ai",
            upstreamProvider: "openai",
            credential: { kind: "none" },
            baseUrl: "https://tenant-a.api.example.com",
          });
          const updatedConfig1 = await r1.getConfig();
          const updatedConfig2 = await r2.getConfig();
          expect(updatedConfig1.providers?.["tenant-a-provider"]).toBeDefined();
          expect(updatedConfig2.providers?.["tenant-a-provider"]).toBeUndefined();
        }
      } finally {
        delete process.env.ANTHROPIC_API_KEY;
        delete process.env.OPENAI_API_KEY;
      }
    });
  });
});
