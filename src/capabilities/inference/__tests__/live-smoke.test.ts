import { describe, it, expect } from "vitest";
import { AggregateInferenceAdapter } from "../aggregate-adapter.js";
import type { InferenceTarget } from "../../../foundations/contracts/backend-ports.js";
import type { CredentialHandle } from "../../../foundations/contracts/credential-store.js";

const OPENAI_KEY = process.env.OPENAI_API_KEY;

function createLiveCredential(key: string): CredentialHandle {
  return {
    id: "cred-live",
    ref: { kind: "env", name: "OPENAI_API_KEY" },
    activeLeaseCount: 0,
    async isResolvable() {
      return true;
    },
    acquireLease() {
      return {
        leaseId: "lease-live",
        isReleased: false,
        async secret() {
          return { kind: "api_key", value: key };
        },
        async release() {},
      };
    },
  };
}

describe("AggregateInferenceAdapter live smoke (optional live keys)", () => {
  it.skipIf(!OPENAI_KEY)("executes real end-to-end chat via PiLanguageRaw with OpenAI", async () => {
    const adapter = new AggregateInferenceAdapter();
    const target: InferenceTarget = {
      providerAccount: "live-openai",
      upstreamProvider: "openai",
      model: "gpt-4o-mini",
      credential: createLiveCredential(OPENAI_KEY!),
    };

    const bound = await adapter.bind(target);
    expect(bound.language).toBeDefined();

    const response = await bound.language!.chat({
      messages: [{ role: "user", content: [{ type: "text", text: "Say 'OK' and nothing else." }] }],
      maxOutputTokens: 10,
    });

    expect(response.message.content.length).toBeGreaterThan(0);
    expect(response.stopReason).toBe("end_turn");
    expect(response.usage?.totalTokens).toBeGreaterThan(0);
  });
});
