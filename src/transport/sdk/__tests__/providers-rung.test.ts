/**
 * Review round-3 P1-2: the providers option family (providers/credentials/
 * modelAssignments/adapter, no explicit runtime) must complete on every SDK
 * rung — spec 027 US1 scenario 2 names the askSeepient one-shot with injected
 * provider configuration as a completing path. Pre-fix, askSeepient read
 * these options as tenancy signals only and silently dropped them, so the
 * one-shot dead-ended in PrincipalRequiredError (no tenancy) or an
 * unconfigured_purpose error naming the very options it had just ignored.
 *
 * This file stays registration-free (no full-registrations import) — it
 * exercises the CORE rungs, and the no-tenancy refusal pin proves the
 * multi upgrade still fires before any bootstrap.
 */
import { describe, it, expect } from "vitest";
import { MemoryCredentialStore } from "../../../domain/providers/credentials/memory-credential-store.js";

const PROVIDERS = {
  "my-openai": {
    adapter: "pi-ai",
    upstreamProvider: "test",
    credential: { kind: "seepient", id: "openai-main" },
  },
};
const ASSIGNMENTS = {
  text: { standard: { providerAccount: "my-openai", model: "test-model" } },
};

/** Structural adapter — the same shape the qs scripts prove end-to-end. */
function mockAdapter(text: string): never {
  const languageBackend = {
    chatStream: async function* () {
      yield { type: "start", resolvedModel: { providerAccount: "my-openai", modelId: "test-model" } };
      yield { type: "content_block_start", index: 0, block: { type: "text", text: "" } };
      yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } };
      yield { type: "content_block_stop", index: 0 };
      yield { type: "finish", stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
    },
    chat: async () => ({ message: { role: "assistant", content: [] }, stopReason: "end_turn" }),
  };
  return {
    id: "mock-adapter",
    async bind(target: unknown) {
      return {
        target,
        language: {
          stream: () => languageBackend.chatStream(),
          chat: languageBackend.chat,
        },
        images: undefined,
      };
    },
    updateCatalog() {},
  } as never;
}

async function makeCredentials(): Promise<MemoryCredentialStore> {
  const credentials = new MemoryCredentialStore();
  await credentials.put("openai-main", { kind: "api_key", keyValue: "sk-test" } as never);
  return credentials;
}

describe("review round-3 P1-2: the providers option family completes on every rung", () => {
  it("askSeepient with providers + credentials (no runtime) reaches the vendor", async () => {
    const { askSeepient } = await import("../ask.js");
    const res = (await askSeepient("Say hi", {
      tenancy: "single",
      skills: false,
      tools: [],
      credentials: await makeCredentials(),
      providers: PROVIDERS,
      modelAssignments: ASSIGNMENTS,
      adapter: mockAdapter("vendor reached"),
    } as { stream?: false })) as { text: string };
    expect(res.text).toBe("vendor reached");
  });

  it("createChat with the README quickstart shape completes send and stream turns", async () => {
    const { createChat } = await import("../chat.js");
    const chat = await createChat({
      stateless: true,
      tenancy: "single",
      skills: false,
      credentials: await makeCredentials(),
      providers: PROVIDERS,
      modelAssignments: ASSIGNMENTS,
      adapter: mockAdapter("second turn"),
    } as never);
    const first = await chat.send("Hello!");
    expect(first.text).toBe("second turn");
    const stream = await chat.stream("Go on");
    await expect(stream.fullText).resolves.toBe("second turn");
  });

  it("without an explicit tenancy the providers shape still upgrades and refuses typed", async () => {
    const { askSeepient } = await import("../ask.js");
    await expect(
      askSeepient("Say hi", {
        skills: false,
        tools: [],
        credentials: await makeCredentials(),
        providers: PROVIDERS,
        modelAssignments: ASSIGNMENTS,
        adapter: mockAdapter("unused"),
      } as never),
    ).rejects.toThrow(/principal/i);
  });

  it("the credentials single-user notice describes the resolved store set (round-3 P2-3, gate r2 P2-C)", async () => {
    const tenancy = await import("../../../domain/tenancy/tenancy-mode.js");
    tenancy.resetTenancyNoticeForTest();
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (m: unknown) => warnings.push(String(m));
    try {
      // Core persona (this file registers no ambient defaults): post-widen
      // the in-memory resolution holds for EVERY single-mode construction,
      // so the notice claims zero writes. The old "pass stateless: true"
      // arm is deleted — it was unreachable and its advice went stale.
      tenancy.emitCredentialsSingleUserWarningOnce();
    } finally {
      console.warn = origWarn;
      tenancy.resetTenancyNoticeForTest();
    }
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("no ambient state is written");
    expect(warnings[0]).not.toContain("pass stateless");
  });
});
