/**
 * Spec 022 — SDK Tenancy Mode & Fail-Closed Defaults (US2: T018–T022).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { askSeepient, createSeepient, createTenantAgent, gateway } from "../index.js";
import { resetTenancyNoticeForTest } from "../../../domain/tenancy/tenancy-mode.js";
import {
  FakeAuditStore,
  FakePolicyStore,
  FakeCapabilityLedger,
  createFakeRuntime,
} from "./helpers/fake-stores.js";

describe("Spec 022 SDK Tenancy Mode & Fail-Closed Enforcement (US2)", () => {
  beforeEach(() => {
    resetTenancyNoticeForTest();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── T018: Once-per-process notice and signal upgrade ─────────────────────────
  describe("T018: resolveTenancyMode & emitTenancyNoticeOnce in SDK roots", () => {
    it("constructs two upgraded agents in one process — notice appears exactly once", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const runtime1 = createFakeRuntime({ responses: [{ text: "ok 1" }] });
      const runtime2 = createFakeRuntime({ responses: [{ text: "ok 2" }] });

      // Agent 1: upgraded to multi due to injected runtime and stores
      await askSeepient("prompt 1", {
        cwd: "/tmp/tenant-1",
        principalId: "tenant-1",
        runtime: runtime1,
        auditStore: new FakeAuditStore(),
        policyStore: new FakePolicyStore(),
        capabilityLedger: new FakeCapabilityLedger(),
        stateless: true,
      });

      // Agent 2: second upgraded agent in same process
      await askSeepient("prompt 2", {
        cwd: "/tmp/tenant-2",
        principalId: "tenant-2",
        runtime: runtime2,
        auditStore: new FakeAuditStore(),
        policyStore: new FakePolicyStore(),
        capabilityLedger: new FakeCapabilityLedger(),
        stateless: true,
      });

      // Assert count is exactly once
      const tenancyNotices = warnSpy.mock.calls.filter((call) =>
        String(call[0]).includes("Tenancy mode automatically upgraded to \"multi\""),
      );
      expect(tenancyNotices).toHaveLength(1);

      warnSpy.mockRestore();
    });

    it("tenancy: 'single' with injection signals present -> no upgrade notice, single semantics", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const runtime = createFakeRuntime({ responses: [{ text: "single mode" }] });
      await askSeepient("prompt", {
        tenancy: "single",
        runtime,
        principalId: "tenant-x",
      });

      const tenancyNotices = warnSpy.mock.calls.filter((call) =>
        String(call[0]).includes("Tenancy mode automatically upgraded to \"multi\""),
      );
      expect(tenancyNotices).toHaveLength(0);

      warnSpy.mockRestore();
    });

    it("skills literals only -> runs in single mode without upgrade notice (FR-016)", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const agent = await createSeepient({
        skills: [
          {
            name: "quick-skill",
            content: "---\nname: quick-skill\ndescription: quick test\n---\nbody",
          },
        ],
      });
      await agent.close().catch(() => {});

      const tenancyNotices = warnSpy.mock.calls.filter((call) =>
        String(call[0]).includes("Tenancy mode automatically upgraded to \"multi\""),
      );
      expect(tenancyNotices).toHaveLength(0);

      warnSpy.mockRestore();
    });

    it("sources injected -> upgrades to multi mode with upgrade notice (FR-016)", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const fakeSource = {
        list: () => [{ name: "s1", content: "---\nname: s1\ndescription: d1\n---\nb", source: "test" }],
      };

      try {
        await createSeepient({
          principalId: "tenant-1",
          sources: [fakeSource],
        });
      } catch {
        // Expected to throw TENANCY_RUNTIME_REQUIRED because upgraded to multi
      }

      const tenancyNotices = warnSpy.mock.calls.filter((call) =>
        String(call[0]).includes("Tenancy mode automatically upgraded to \"multi\""),
      );
      expect(tenancyNotices).toHaveLength(1);

      warnSpy.mockRestore();
    });
  });

  // ── FR-020: PRINCIPAL_REQUIRED enforcement in multi mode ──────────────────
  describe("FR-020: PRINCIPAL_REQUIRED enforcement at both SDK roots", () => {
    it("createSeepient in multi mode without principalId throws PRINCIPAL_REQUIRED", async () => {
      await expect(
        createSeepient({
          tenancy: "multi",
        }),
      ).rejects.toMatchObject({
        code: "PRINCIPAL_REQUIRED",
        retryable: false,
      });
    });

    it("askSeepient in multi mode without principalId throws PRINCIPAL_REQUIRED", async () => {
      await expect(
        askSeepient("test", {
          tenancy: "multi",
        }),
      ).rejects.toMatchObject({
        code: "PRINCIPAL_REQUIRED",
        retryable: false,
      });
    });

    it("upgraded multi mode without principalId throws PRINCIPAL_REQUIRED", async () => {
      const runtime = createFakeRuntime();
      await expect(
        createSeepient({
          runtime,
          auditStore: new FakeAuditStore(),
          policyStore: new FakePolicyStore(),
          capabilityLedger: new FakeCapabilityLedger(),
        }),
      ).rejects.toMatchObject({
        code: "PRINCIPAL_REQUIRED",
        retryable: false,
      });
    });
  });

  // ── FR-015: TENANCY_WORKSPACE_REQUIRED enforcement in multi mode ───────────
  describe("FR-015: TENANCY_WORKSPACE_REQUIRED enforcement at both SDK roots", () => {
    it("createSeepient in multi mode without cwd throws TENANCY_WORKSPACE_REQUIRED", async () => {
      const runtime = createFakeRuntime();
      await expect(
        createSeepient({
          tenancy: "multi",
          principalId: "tenant-1",
          runtime,
          auditStore: new FakeAuditStore(),
          policyStore: new FakePolicyStore(),
          capabilityLedger: new FakeCapabilityLedger(),
        }),
      ).rejects.toMatchObject({
        code: "TENANCY_WORKSPACE_REQUIRED",
        retryable: false,
      });
    });

    it("askSeepient in multi mode without cwd throws TENANCY_WORKSPACE_REQUIRED", async () => {
      const runtime = createFakeRuntime();
      await expect(
        askSeepient("test", {
          tenancy: "multi",
          principalId: "tenant-1",
          runtime,
          auditStore: new FakeAuditStore(),
          policyStore: new FakePolicyStore(),
          capabilityLedger: new FakeCapabilityLedger(),
          stateless: true,
        }),
      ).rejects.toMatchObject({
        code: "TENANCY_WORKSPACE_REQUIRED",
        retryable: false,
      });
    });
  });

  // ── T019: TENANCY_RUNTIME_REQUIRED in multi mode ──────────────────────────
  describe("T019: TENANCY_RUNTIME_REQUIRED enforcement at both roots", () => {
    it("createSeepient in multi mode without runtime throws TENANCY_RUNTIME_REQUIRED with remediation", async () => {
      await expect(
        createSeepient({
          tenancy: "multi",
          principalId: "tenant-1",
        }),
      ).rejects.toMatchObject({
        code: "TENANCY_RUNTIME_REQUIRED",
        retryable: false,
      });
    });

    it("askSeepient in multi mode without runtime throws TENANCY_RUNTIME_REQUIRED with remediation", async () => {
      await expect(
        askSeepient("test", {
          tenancy: "multi",
          principalId: "tenant-1",
        }),
      ).rejects.toMatchObject({
        code: "TENANCY_RUNTIME_REQUIRED",
        retryable: false,
      });
    });
  });

  // ── T020: Completeness validator (multi error vs single warning) ───────────
  describe("T020: Completeness validator replaces warnIfPartialStoreInjection", () => {
    it("multi mode with missing stores throws itemized TENANCY_STORE_INCOMPLETE", async () => {
      const runtime = createFakeRuntime();
      try {
        await createSeepient({
          tenancy: "multi",
          principalId: "tenant-1",
          runtime,
          auditStore: new FakeAuditStore(),
          // policyStore and capabilityLedger missing
        });
        expect.unreachable("should have thrown");
      } catch (err: any) {
        expect(err.code).toBe("TENANCY_STORE_INCOMPLETE");
        expect(err.retryable).toBe(false);
        expect(err.missingStores).toContain("policyStore");
        expect(err.missingStores).toContain("capabilityLedger");
        expect(err.message).toContain("policyStore");
        expect(err.message).toContain("capabilityLedger");
      }
    });

    it("single mode with partial stores logs verbatim legacy warning", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const agent = await createSeepient({
        tenancy: "single",
        auditStore: new FakeAuditStore(),
        // 1 of 3 injected
      });
      await agent.close().catch(() => {});

      const partialWarnings = warnSpy.mock.calls.filter((call) =>
        String(call[0]).includes("Partial state store injection detected"),
      );
      expect(partialWarnings).toHaveLength(1);
      expect(partialWarnings[0][0]).toContain(
        "For fully stateless worker execution, all three permission stores (auditStore, policyStore, capabilityLedger) must be injected.",
      );

      warnSpy.mockRestore();
    });
  });

  // ── T021: Ambient I/O Guard in multi mode ────────────────────────────────
  describe("T021: Ambient I/O Guard in multi mode", () => {
    it("gateway.createGateway throws TENANCY_AMBIENT_IO if settingsAdapter is omitted in multi mode", async () => {
      await expect(
        gateway.createGateway({ enabled: true } as any, undefined, { tenancy: "multi" }),
      ).rejects.toMatchObject({
        code: "TENANCY_AMBIENT_IO",
        retryable: false,
      });
    });
  });

  // ── T022: Env-credential classification check ────────────────────────────
  describe("T022: Env-credential classification check (M10)", () => {
    const originalOpenAiKey = process.env.OPENAI_API_KEY;

    afterEach(() => {
      if (originalOpenAiKey !== undefined) {
        process.env.OPENAI_API_KEY = originalOpenAiKey;
      } else {
        delete process.env.OPENAI_API_KEY;
      }
    });

    it("multi agent with injected runtime lacking provider does not fall back to ambient env credential", async () => {
      process.env.OPENAI_API_KEY = "sk-ambient-env-key-that-must-not-be-used";

      // Injected runtime that has no openai provider configured
      const emptyRuntime = createFakeRuntime();

      // In multi mode, the model call fails because injected runtime has no openai provider
      // and does NOT fall back to synthesizing openai provider from ambient OPENAI_API_KEY
      await expect(
        askSeepient("test query", {
          cwd: "/tmp/test",
          principalId: "test-principal",
          tenancy: "multi",
          runtime: emptyRuntime,
          auditStore: new FakeAuditStore(),
          policyStore: new FakePolicyStore(),
          capabilityLedger: new FakeCapabilityLedger(),
          stateless: true,
          provider: "openai",
        }),
      ).rejects.toThrow();
    });
  });

  // ── DP10: createTenantAgent typed factory ─────────────────────────────────
  describe("DP10: createTenantAgent typed constructor entry", () => {
    it("validates principalId at entry (empty, sentinel, regex)", async () => {
      const runtime = createFakeRuntime();
      const baseOpts = {
        cwd: "/tmp/tenant-test",
        runtime,
        auditStore: new FakeAuditStore(),
        policyStore: new FakePolicyStore(),
        capabilityLedger: new FakeCapabilityLedger(),
      };

      // Empty principalId
      await expect(
        createTenantAgent({ ...baseOpts, principalId: "" }),
      ).rejects.toMatchObject({
        code: "PRINCIPAL_REQUIRED",
      });

      // Sentinel principalId
      await expect(
        createTenantAgent({ ...baseOpts, principalId: "default" }),
      ).rejects.toMatchObject({
        code: "INVALID_PRINCIPAL_ID",
      });

      // Invalid character principalId
      await expect(
        createTenantAgent({ ...baseOpts, principalId: "bad/principal/id" }),
      ).rejects.toMatchObject({
        code: "INVALID_PRINCIPAL_ID",
      });
    });

    it("creates a functional multi-tenant agent on happy path", async () => {
      const runtime = createFakeRuntime({
        responses: [{ text: "Hello from isolated tenant agent" }],
      });

      const agent = await createTenantAgent({
        principalId: "tenant_corp_123",
        cwd: "/tmp/tenant_corp_123",
        runtime,
        auditStore: new FakeAuditStore(),
        policyStore: new FakePolicyStore(),
        capabilityLedger: new FakeCapabilityLedger(),
      });

      expect(agent).toBeDefined();
      expect(typeof agent.chat).toBe("function");
      await agent.close();
    });

    it("T065: credentials-only injection upgrades to multi with PrincipalRequiredError guidance (FR-037)", async () => {
      const { MemoryCredentialStore } = await import("../../../domain/providers/credentials/memory-credential-store.js");
      const creds = new MemoryCredentialStore({ isIsolated: true });

      await expect(
        createSeepient({
          credentials: creds,
        }),
      ).rejects.toMatchObject({
        name: "PrincipalRequiredError",
        code: "PRINCIPAL_REQUIRED",
      });
    });
  });
});
