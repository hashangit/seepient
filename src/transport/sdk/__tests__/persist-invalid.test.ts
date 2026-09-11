import { describe, it, expect } from "vitest";
import { createSeepient } from "../seepient.js";
import { PersistConfigInvalidError, SessionIdInvalidError } from "../../../foundations/errors.js";
import { askSeepient } from "../index.js";

describe("createSeepient - persist shape validation (FR-012)", () => {
  it("throws PersistConfigInvalidError when persist is an unrecognized object shape", async () => {
    // The legacy/retired SessionStore shape documented in R9
    const legacySessionStore = {
      get: async () => [],
      set: async () => {},
    };

    await expect(
      createSeepient({
        tenancy: "single",
        provider: "fake",
        model: "fake-model",
        persist: legacySessionStore as any,
      }),
    ).rejects.toThrow(PersistConfigInvalidError);

    try {
      await createSeepient({
        tenancy: "single",
        provider: "fake",
        model: "fake-model",
        persist: legacySessionStore as any,
      });
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err).toBeInstanceOf(PersistConfigInvalidError);
      expect(err.code).toBe("PERSIST_CONFIG_INVALID");
      expect(err.message).toContain("PERSIST_CONFIG_INVALID");
      expect(err.message).toContain("Supported forms are");
    }
  });

  it("throws PersistConfigInvalidError for arbitrary unsupported objects", async () => {
    await expect(
      createSeepient({
        tenancy: "single",
        provider: "fake",
        model: "fake-model",
        persist: { invalid: true } as any,
      }),
    ).rejects.toThrow(PersistConfigInvalidError);
  });
});

describe("Session ID validation (FR-018)", () => {
  it("throws SessionIdInvalidError at construction when sessionId exceeds 128 chars in createSeepient", async () => {
    const longId = "a".repeat(129);
    await expect(
      createSeepient({
        tenancy: "single",
        provider: "fake",
        model: "fake-model",
        sessionId: longId,
      }),
    ).rejects.toThrow(SessionIdInvalidError);

    try {
      await createSeepient({
        tenancy: "single",
        provider: "fake",
        model: "fake-model",
        sessionId: longId,
      });
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err).toBeInstanceOf(SessionIdInvalidError);
      expect(err.code).toBe("SESSION_ID_INVALID");
      expect(err.message).toContain("max 128 characters");
    }
  });

  it("throws SessionIdInvalidError when sessionId contains invalid characters in createSeepient", async () => {
    await expect(
      createSeepient({
        tenancy: "single",
        provider: "fake",
        model: "fake-model",
        sessionId: "invalid/session/id",
      }),
    ).rejects.toThrow(SessionIdInvalidError);
  });

  it("throws SessionIdInvalidError at call time when sessionId exceeds 128 chars in askSeepient", async () => {
    const longId = "b".repeat(129);
    await expect(
      askSeepient("hello", {
        sessionId: longId,
      }),
    ).rejects.toThrow(SessionIdInvalidError);

    try {
      await askSeepient("hello", {
        sessionId: longId,
      });
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err).toBeInstanceOf(SessionIdInvalidError);
      expect(err.code).toBe("SESSION_ID_INVALID");
      expect(err.message).toContain("max 128 characters");
    }
  });

  it("accepts valid 128-char sessionId in createSeepient", async () => {
    const valid128 = "a".repeat(128);
    const agent = await createSeepient({
      tenancy: "single",
      provider: "fake",
      model: "fake-model",
      sessionId: valid128,
    });
    expect(agent.sessionId).toBe(valid128);
  });
});

