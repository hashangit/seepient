/**
 * Spec 022 — SDK Tenancy Mode & Fail-Closed Defaults (US2: T018–T022).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { askSeepient, createSeepient, gateway } from "../index.js";
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

  // ── T018: Once-per-process notice and signal upgrade ─────────────────────────
  describe("T018: resolveTenancyMode & emitTenancyNoticeOnce in SDK roots", () => {
    it("constructs two upgraded agents in one process — notice appears exactly once", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const runtime1 = createFakeRuntime({ responses: [{ text: "ok 1" }] });
      const runtime2 = createFakeRuntime({ responses: [{ text: "ok 2" }] });

      // Agent 1: upgraded to multi due to injected runtime and stores
      await askSeepient("prompt 1", {
        runtime: runtime1,
        auditStore: new FakeAuditStore(),
        policyStore: new FakePolicyStore(),
        capabilityLedger: new FakeCapabilityLedger(),
        stateless: true,
      });

      // Agent 2: second upgraded agent in same process
      await askSeepient("prompt 2", {
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
  });

  // ── T019: TENANCY_RUNTIME_REQUIRED in multi mode ──────────────────────────
  describe("T019: TENANCY_RUNTIME_REQUIRED enforcement at both roots", () => {
    it("createSeepient in multi mode without runtime throws TENANCY_RUNTIME_REQUIRED with remediation", async () => {
      await expect(
        createSeepient({
          tenancy: "multi",
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
});
