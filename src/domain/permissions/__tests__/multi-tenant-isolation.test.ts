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

import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";
import { mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let createSeepient: any;
let askSeepient: any;
let FakeAuditStore: any;
let FakePolicyStore: any;
let FakeCapabilityLedger: any;
let RecordingPersistenceBackend: any;
let createFakeRuntime: any;

beforeAll(async () => {
  const sdk = await import("../../../transport/sdk/index.js");
  createSeepient = sdk.createSeepient;
  askSeepient = sdk.askSeepient;
  const fakes = await import("../../../transport/sdk/__tests__/helpers/fake-stores.js");
  FakeAuditStore = fakes.FakeAuditStore;
  FakePolicyStore = fakes.FakePolicyStore;
  FakeCapabilityLedger = fakes.FakeCapabilityLedger;
  RecordingPersistenceBackend = fakes.RecordingPersistenceBackend;
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
import type { SkillSource } from "../../../capabilities/skills/types.js";
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
        } as any),
      ).rejects.toThrowError(
        expect.objectContaining({
          code: "TENANCY_RUNTIME_REQUIRED",
        }),
      );
    });

    it("Dim 5: Grants — Tenant A stored grants do not authorize Tenant B", async () => {
      const policyStore = new FakePolicyStore();
      const workspaceId = "ws-shared";

      // Tenant A records a grant
      await policyStore.compareAndSet(
        workspaceId,
        0,
        {
          version: 1,
          capabilities: [
            {
              kind: "process",
              command: "echo 'hello'",
              principalId: "tenant-a",
            } as any,
          ],
        },
        { type: "user", principalId: "tenant-a" } as any,
      );

      // Tenant B reads policy under principal "tenant-b"
      const snapB = await (policyStore as any).read(workspaceId, { principalId: "tenant-b" });
      const bCaps = snapB.policy.capabilities.filter(
        (c: any) => c.command === "echo 'hello'",
      );
      // Fails on untouched tree: PolicyStore does not filter by principalId yet
      expect(bCaps.length).toBe(0);
    });

    it("Dim 6: Ledger — Tenant A consuming digest D does not deny Tenant B consuming D", async () => {
      const ledger = new FakeCapabilityLedger();
      const digest = "action-digest-123";

      // Tenant A consumes digest
      const consumedA = await (ledger as any).consume("env-a", digest, { principalId: "tenant-a" });
      expect(consumedA).toBe(true);

      // Tenant B consumes identical digest
      // Fails on untouched tree: flat ledger has single global consumedDigests set
      const consumedB = await (ledger as any).consume("env-b", digest, { principalId: "tenant-b" });
      expect(consumedB).toBe(true);
    });

    it("Dim 7: Sessions & skills — Session resume cross-principal fails with SESSION_OWNERSHIP_MISMATCH and multi mode skill catalogs isolate to injected sources", async () => {
      const backend = new RecordingPersistenceBackend();
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
        id: "source-tenant-a",
        kind: "in-memory",
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
      const audit = new FakeAuditStore();
      const policy = new FakePolicyStore();
      const ledger = new FakeCapabilityLedger();
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
        tenancy: "multi",
        runtime,
        auditStore: audit,
        policyStore: policy,
        capabilityLedger: ledger,
        stateless: true,
      } as any);

      // Verify no files or directories were created anywhere in sandboxHome
      expect(readdirSync(sandboxHome)).toEqual([]);
      expect(existsSync(join(sandboxHome, ".seepient"))).toBe(false);
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
          tenancy: "multi",
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
  });
});
