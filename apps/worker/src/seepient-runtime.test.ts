import { describe, expect, it, vi } from "vitest";
import { ModelCredentialRequiredError } from "@seepients/adapter-kit";
import { seepientResolveEngineOptions } from "./seepient-runtime.js";

const deps = {
  prisma: {} as never,
  secretStore: {} as never,
};

function runRequest(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    model: { provider: "openrouter", id: "openai/gpt-6-luna" },
    ...overrides,
  } as never;
}

describe("seepient runtime composition (S10 account mapping)", () => {
  it("admits the operator-trusted platform account: a request-borne deployment key builds engine options", async () => {
    const options = await seepientResolveEngineOptions(
      runRequest({
        model: { provider: "openrouter", id: "openai/gpt-6-luna", apiKey: "sk-deployment" },
      }),
      deps,
    );
    expect(options.tenancy).toBe("single");
    expect(options.model).toBe("openai/gpt-6-luna");
    expect(options.providerAccount).toBe("seepients-app-model");
    // The key rides the per-run memory store, not the options object.
    expect(JSON.stringify(options)).not.toContain("sk-deployment");
    const provider = options.providers!["seepients-app-model"]!;
    expect(provider.upstreamProvider).toBe("openrouter");
    expect(provider.credential).toEqual({ kind: "seepient", id: "seepients-app-model-key" });
  });

  it("resolves through the trusted composition callback when the request carries no key", async () => {
    const resolveModel = vi.fn(async () => ({
      provider: "anthropic",
      id: "claude-sonnet-5",
      apiKey: "sk-stored",
      baseUrl: "https://gateway.example",
    }));
    const options = await seepientResolveEngineOptions(runRequest({ resolveModel }), deps);
    expect(resolveModel).toHaveBeenCalledExactlyOnceWith("openrouter", "openai/gpt-6-luna");
    expect(options.model).toBe("claude-sonnet-5");
    const provider = options.providers!["seepients-app-model"]!;
    expect(provider.upstreamProvider).toBe("anthropic");
    expect(provider.baseUrl).toBe("https://gateway.example");
  });

  it("binds model-oauth runs to the durable credential adapter", async () => {
    const options = await seepientResolveEngineOptions(
      runRequest({
        model: {
          provider: "anthropic",
          id: "claude-sonnet-5",
          oauth: {
            credential: { type: "oauth", access: "a", refresh: "r", expires: 1 },
            handle: { credentialId: "cred-1", secretId: "sec-1", userId: "u1", spaceId: "s1" },
          },
        },
      }),
      deps,
    );
    expect(options.tenancy).toBe("single");
    expect(options.providerAccount).toBe("seepients-app-model");
    const credentials = options.credentials as { isIsolated?: boolean };
    // Durable, product-backed: not the per-run isolated memory store.
    expect(credentials.isIsolated).toBe(false);
  });

  it("refuses an oauth credential without its durable row handle", async () => {
    await expect(
      seepientResolveEngineOptions(
        runRequest({
          model: {
            provider: "anthropic",
            id: "claude-sonnet-5",
            oauth: {
              credential: { type: "oauth", access: "a", refresh: "r", expires: 1 },
            },
          },
        }),
        deps,
      ),
    ).rejects.toMatchObject({ code: "CREDENTIAL_REQUIRED" });
  });

  it("fails closed typed when no stored credential and no platform account apply", async () => {
    const resolveModel = vi.fn(async () => undefined);
    await expect(
      seepientResolveEngineOptions(runRequest({ resolveModel }), deps),
    ).rejects.toBeInstanceOf(ModelCredentialRequiredError);
    await expect(
      seepientResolveEngineOptions(runRequest({ resolveModel }), deps),
    ).rejects.toMatchObject({ code: "CREDENTIAL_REQUIRED" });
  });

  it("fails closed typed when there is no resolution callback at all", async () => {
    await expect(seepientResolveEngineOptions(runRequest(), deps)).rejects.toMatchObject({
      code: "CREDENTIAL_REQUIRED",
    });
  });
});
