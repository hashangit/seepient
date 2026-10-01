/**
 * J6 Adversarial Journey — VULN-16: pi-ai ambient auth fallback and baseUrl exfiltration.
 *
 * Verifies the 022-5 FR-007 credential discipline (tenancy-invariant): raw inference
 * wrappers throw CREDENTIAL_REQUIRED for valueless/undefined secrets, and map
 * kind:"none" to the explicit "unused" sentinel so the vendored pi-ai layer never
 * falls back to host process.env keys (37 env names) — no decoy key can reach any
 * wire, even toward an attacker-controlled baseUrl.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PiLanguageRaw } from "../pi-language-raw.js";
import { PiImageRaw } from "../pi-image-raw.js";
import { createSecurityGuard } from "../../../foundations/__tests__/guard.js";
import type { InferenceTarget } from "../../../foundations/contracts/backend-ports.js";

describe("J6 Inference Fail-Closed Journey (VULN-16)", () => {
  const originalEnv = process.env;
  let guard = createSecurityGuard("VULN-16");

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.OPENAI_API_KEY = "sk-host-operator-decoy-token";
    process.env.ANTHROPIC_API_KEY = "sk-ant-host-operator-decoy-token";
    guard = createSecurityGuard("VULN-16");
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("text inference wrapper maps kind-none to the unused sentinel in multi mode (no decoy on the wire)", async () => {
    const raw = new PiLanguageRaw();

    const target: InferenceTarget = {
      providerAccount: "tenant-account-1",
      upstreamProvider: "openai",
      model: "gpt-4o",
      credential: {
        id: "cred-none",
        ref: { kind: "none" } as any,
        activeLeaseCount: 0,
        async isResolvable() { return true; },
        acquireLease() {
          return {
            id: "lease-none",
            credentialId: "cred-none",
            released: false,
            async secret() {
              guard.recordHit("target.credential.secret.text");
              return { kind: "none" };
            },
            async release() {},
          } as any;
        },
      },
    };

    // 022-5: kind "none" maps to the "unused" sentinel (tenancy-invariant), so the
    // credential gate PASSES; the request proceeds to the target baseUrl. Point it
    // at an unroutable loopback port: the call must fail as a network error — never
    // CREDENTIAL_REQUIRED, and never carrying the host decoy key.
    target.baseUrl = "http://127.0.0.1:9/v1";
    const seen: string[] = [];
    try {
      const generator = raw.chatStream(target, {
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      }, {
        tenancyMode: "multi",
        capabilities: [{ kind: "network-destination", scheme: "http", host: "127.0.0.1", port: 9 }],
      } as any);
      for await (const event of generator) {
        seen.push(JSON.stringify(event));
      }
    } catch (err: any) {
      seen.push(String(err?.message ?? err?.code));
    }
    // The sink failure may surface as a thrown error or an error event; either
    // way the sentinel passed the credential gate and no decoy can appear.
    const transcript = seen.join("\n");
    expect(transcript).not.toMatch(/CREDENTIAL_REQUIRED/);
    expect(transcript).not.toContain("sk-host-operator-decoy-token");
    guard.assertGuardedPathExecuted(1);
  });

  it("image inference wrapper maps kind-none to the unused sentinel in multi mode (no decoy on the wire)", async () => {
    const imageRaw = new PiImageRaw();

    const target: InferenceTarget = {
      providerAccount: "tenant-account-1",
      upstreamProvider: "openai",
      model: "dall-e-3",
      credential: {
        id: "cred-none",
        ref: { kind: "none" } as any,
        activeLeaseCount: 0,
        async isResolvable() { return true; },
        acquireLease() {
          return {
            id: "lease-none",
            credentialId: "cred-none",
            released: false,
            async secret() {
              guard.recordHit("target.credential.secret.image");
              return { kind: "none" };
            },
            async release() {},
          } as any;
        },
      },
    };

    // 022-5: sentinel semantics (see the text case above) — the gate passes for
    // kind "none" and the egress assert still applies to the account baseUrl.
    target.baseUrl = "http://127.0.0.1:9/v1";
    let threw = false;
    try {
      await imageRaw.generate(target, {
        prompt: "A test prompt",
      }, {
        tenancyMode: "multi",
        capabilities: [{ kind: "network-destination", scheme: "http", host: "127.0.0.1", port: 9 }],
      } as any);
    } catch (err: any) {
      threw = true;
      const text = `${err.message ?? err.code}`;
      expect(text).not.toMatch(/CREDENTIAL_REQUIRED/);
      expect(text).not.toContain("sk-host-operator-decoy-token");
    }

    expect(threw).toBe(true);
    guard.assertGuardedPathExecuted(1);
  });

  it("text inference refuses attacker-origin baseUrl without matching network-destination capability in multi mode", async () => {
    const raw = new PiLanguageRaw();

    const target: InferenceTarget = {
      providerAccount: "tenant-account-1",
      upstreamProvider: "openai",
      model: "gpt-4o",
      baseUrl: "https://evil-attacker.example.com/v1",
      credential: {
        id: "cred-key",
        ref: { kind: "api_key" } as any,
        activeLeaseCount: 0,
        async isResolvable() { return true; },
        acquireLease() {
          return {
            id: "lease-key",
            credentialId: "cred-key",
            released: false,
            async secret() { return { kind: "api_key", value: "sk-tenant-valid" }; },
            async release() {},
          } as any;
        },
      },
    };

    let threw = false;
    try {
      const generator = raw.chatStream(target, {
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      }, {
        tenancyMode: "multi",
        capabilities: [
          { kind: "network-destination", scheme: "https", host: "api.openai.com" },
        ],
      } as any);
      for await (const _event of generator) {}
    } catch (err: any) {
      threw = true;
      expect(err.message).toMatch(/EGRESS_REQUIRED/);
    }

    expect(threw).toBe(true);
  });

  it("unknown upstream synthetic fallback to openai is refused in multi mode", async () => {
    const raw = new PiLanguageRaw();

    const target: InferenceTarget = {
      providerAccount: "tenant-account-1",
      upstreamProvider: "attacker-unknown-provider",
      model: "gpt-4o",
      baseUrl: "https://attacker.example.com",
      credential: {
        id: "cred-key",
        ref: { kind: "api_key" } as any,
        activeLeaseCount: 0,
        async isResolvable() { return true; },
        acquireLease() {
          return {
            id: "lease-key",
            credentialId: "cred-key",
            released: false,
            async secret() { return { kind: "api_key", value: "sk-tenant-valid" }; },
            async release() {},
          } as any;
        },
      },
    };

    let threw = false;
    try {
      const generator = raw.chatStream(target, {
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      }, {
        tenancyMode: "multi",
        capabilities: [
          { kind: "network-destination", scheme: "https", host: "attacker.example.com" },
        ],
      } as any);
      for await (const _event of generator) {}
    } catch (err: any) {
      threw = true;
      expect(err.message).toMatch(/forbidden in multi-tenant mode/);
    }

    expect(threw).toBe(true);
  });

  it("allowed-origin baseUrl sends tenant key only to target in multi mode", async () => {
    let capturedStreamOptions: any;
    let capturedModel: any;

    const mockModels: any = {
      getModel: vi.fn().mockReturnValue({
        id: "gpt-4o",
        provider: "openai",
        api: "openai-completions",
        baseUrl: "https://api.openai.com/v1",
      }),
      getProviders: vi.fn().mockReturnValue([{ id: "openai" }]),
      stream: vi.fn().mockImplementation((model: any, _context: any, options: any) => {
        capturedModel = model;
        capturedStreamOptions = options;
        return (async function* () {
          yield { type: "text_start", contentIndex: 0 };
          yield { type: "text_delta", contentIndex: 0, delta: "pong" };
          yield { type: "text_end", contentIndex: 0 };
        })();
      }),
    };

    const raw = new PiLanguageRaw(mockModels);

    const target: InferenceTarget = {
      providerAccount: "tenant-account-1",
      upstreamProvider: "openai",
      model: "gpt-4o",
      baseUrl: "https://custom-gateway.internal/v1",
      credential: {
        id: "cred-key",
        ref: { kind: "api_key" } as any,
        activeLeaseCount: 0,
        async isResolvable() { return true; },
        acquireLease() {
          return {
            id: "lease-key",
            credentialId: "cred-key",
            released: false,
            async secret() { return { kind: "api_key", value: "sk-tenant-isolated-key" }; },
            async release() {},
          } as any;
        },
      },
    };

    const generator = raw.chatStream(target, {
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    }, {
      tenancyMode: "multi",
      capabilities: [
        { kind: "network-destination", scheme: "https", host: "custom-gateway.internal" },
      ],
    } as any);

    const events: any[] = [];
    for await (const event of generator) {
      events.push(event);
    }

    expect(events.length).toBeGreaterThan(0);
    expect(capturedModel.baseUrl).toBe("https://custom-gateway.internal/v1");
    // Verified: options.apiKey is explicit tenant key, NOT host operator key
    expect(capturedStreamOptions.apiKey).toBe("sk-tenant-isolated-key");
    expect(capturedStreamOptions.apiKey).not.toBe(process.env.OPENAI_API_KEY);
  });

  it("single-mode kind-none resolves to the unused sentinel (022-5 tenancy-invariant pin)", async () => {
    let capturedStreamOptions: any;

    const mockModels: any = {
      getModel: vi.fn().mockReturnValue({
        id: "gpt-4o",
        provider: "openai",
        api: "openai-completions",
        baseUrl: "https://api.openai.com/v1",
      }),
      getProviders: vi.fn().mockReturnValue([{ id: "openai" }]),
      stream: vi.fn().mockImplementation((_model: any, _context: any, options: any) => {
        capturedStreamOptions = options;
        return (async function* () {
          yield { type: "text_start", contentIndex: 0 };
          yield { type: "text_delta", contentIndex: 0, delta: "pong" };
          yield { type: "text_end", contentIndex: 0 };
        })();
      }),
    };

    const raw = new PiLanguageRaw(mockModels);

    const target: InferenceTarget = {
      providerAccount: "local-user",
      upstreamProvider: "openai",
      model: "gpt-4o",
      credential: {
        id: "cred-none",
        ref: { kind: "none" } as any,
        activeLeaseCount: 0,
        async isResolvable() { return true; },
        acquireLease() {
          return {
            id: "lease-none",
            credentialId: "cred-none",
            released: false,
            async secret() { return { kind: "none" }; },
            async release() {},
          } as any;
        },
      },
    };

    const generator = raw.chatStream(target, {
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    }, {
      tenancyMode: "single",
    } as any);

    const events: any[] = [];
    for await (const event of generator) {
      events.push(event);
    }

    expect(events.length).toBeGreaterThan(0);
    // 022-5 FR-007 (tenancy-invariant): single mode maps kind "none" to the
    // "unused" sentinel too — the vendored layer must never receive undefined
    // (it would fall back to host process.env).
    expect(capturedStreamOptions.apiKey).toBe("unused");
  });
});
