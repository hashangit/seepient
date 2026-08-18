import { describe, it, expect, vi } from "vitest";
import { ProviderRuntime, calculateInferenceCost } from "../provider-runtime.js";
import { ProviderConfigStore } from "../config-store/provider-config-store.js";
import { MemoryCredentialStore } from "../credentials/memory-credential-store.js";
import { InferenceError } from "../../../foundations/errors.js";
import type { BoundAdapter, InferenceAdapter, InferenceTarget } from "../../../foundations/contracts/backend-ports.js";

describe("Phase 7: Production Reliability (QS-P7.1 - QS-P7.5)", () => {
  // ── QS-P7.1: Multi-target retry, cooldown, and streaming no-replay ────────
  describe("QS-P7.1: Multi-target retry & cooldown", () => {
    it("walks ordered fallback targets and respects cooldown", async () => {
      const attempts: string[] = [];
      const configStore = new ProviderConfigStore(":memory:");
      await configStore.updateOverlay({
        providers: {
          primary: { adapter: "pi-ai", upstreamProvider: "openai", credential: { kind: "none" } },
          secondary: { adapter: "pi-ai", upstreamProvider: "anthropic", credential: { kind: "none" } },
        },
        modelAssignments: {
          text: {
            standard: {
              providerAccount: "primary",
              model: "gpt-4o",
              fallback: [{ providerAccount: "secondary", model: "claude-3-5-sonnet" }],
            },
          },
        },
        retryPolicy: {
          maxAttempts: 3,
          initialBackoffMs: 10,
          maxBackoffMs: 50,
          backoffMultiplier: 1.5,
          cooldownThreshold: 2,
          cooldownDurationMs: 5000,
        },
      }, 0);

      const credentialStore = new MemoryCredentialStore();
      let failPrimary = true;

      const adapter: InferenceAdapter = {
        id: "test-adapter",
        async bind(target: InferenceTarget) {
          attempts.push(`${target.providerAccount}:${target.model}`);
          if (target.providerAccount === "primary" && failPrimary) {
            throw new InferenceError({
              code: "rate_limit",
              message: "Rate limit exceeded",
              providerAccount: target.providerAccount,
              model: target.model,
              retryable: true,
            });
          }
          return {
            target,
            language: {
              async *stream() {
                yield {
                  type: "content_block_delta",
                  index: 0,
                  delta: { type: "text_delta", text: "Success from secondary" },
                };
                yield {
                  type: "finish",
                  stopReason: "end_turn",
                  usage: { inputTokens: 10, outputTokens: 20 },
                };
              },
            },
          } as unknown as BoundAdapter;
        },
      };

      const runtime = new ProviderRuntime({ configStore, credentialStore, adapter });
      const snapshot = await runtime.createTurnSnapshot();
      const plan = await runtime.resolvePlan(snapshot, "text", "standard");

      // Execution 1: primary fails, falls back to secondary
      const events: any[] = [];
      for await (const event of runtime.executeLanguage(plan, { messages: [] })) {
        events.push(event);
      }

      expect(attempts).toEqual(["primary:gpt-4o", "secondary:claude-3-5-sonnet"]);
      expect(events.some((e) => e.type === "content_block_delta")).toBe(true);

      // Check health: primary has 1 failure
      expect(runtime.getHealth("primary", "language").consecutiveFailures).toBe(1);

      // Execution 2: primary fails again -> enters cooldown (threshold = 2)
      attempts.length = 0;
      for await (const _ of runtime.executeLanguage(plan, { messages: [] })) {}
      expect(runtime.getHealth("primary", "language").consecutiveFailures).toBe(2);
      expect(runtime.getHealth("primary", "language").cooldownUntil).toBeDefined();

      // Execution 3: primary is in cooldown -> directly skips to secondary
      attempts.length = 0;
      for await (const _ of runtime.executeLanguage(plan, { messages: [] })) {}
      expect(attempts).toEqual(["secondary:claude-3-5-sonnet"]);
    });

    it("does not replay or fallback after first stream delta has been emitted", async () => {
      const configStore = new ProviderConfigStore(":memory:");
      await configStore.updateOverlay({
        providers: {
          primary: { adapter: "pi-ai", upstreamProvider: "openai", credential: { kind: "none" } },
          secondary: { adapter: "pi-ai", upstreamProvider: "anthropic", credential: { kind: "none" } },
        },
        modelAssignments: {
          text: {
            standard: {
              providerAccount: "primary",
              model: "gpt-4o",
              fallback: [{ providerAccount: "secondary", model: "claude-3-5-sonnet" }],
            },
          },
        },
      }, 0);

      const attempts: string[] = [];
      const adapter: InferenceAdapter = {
        id: "test-adapter",
        async bind(target: InferenceTarget) {
          attempts.push(`${target.providerAccount}:${target.model}`);
          return {
            target,
            language: {
              async *stream() {
                yield {
                  type: "content_block_delta",
                  index: 0,
                  delta: { type: "text_delta", text: "Partial tokens..." },
                };
                // Failure after emitting delta
                yield {
                  type: "error",
                  error: { code: "network_error", message: "Mid-stream disconnect", retryable: true },
                };
              },
            },
          } as unknown as BoundAdapter;
        },
      };

      const runtime = new ProviderRuntime({ configStore, adapter });
      const snapshot = await runtime.createTurnSnapshot();
      const plan = await runtime.resolvePlan(snapshot, "text", "standard");

      const events: any[] = [];
      for await (const event of runtime.executeLanguage(plan, { messages: [] })) {
        events.push(event);
      }

      // Assert: secondary was NOT attempted because stream already emitted partial output
      expect(attempts).toEqual(["primary:gpt-4o"]);
      expect(events.some((e) => e.type === "error")).toBe(true);
    });

    it("does not retry non-retryable errors", async () => {
      const configStore = new ProviderConfigStore(":memory:");
      await configStore.updateOverlay({
        providers: {
          primary: { adapter: "pi-ai", upstreamProvider: "openai", credential: { kind: "none" } },
          secondary: { adapter: "pi-ai", upstreamProvider: "anthropic", credential: { kind: "none" } },
        },
        modelAssignments: {
          text: {
            standard: {
              providerAccount: "primary",
              model: "gpt-4o",
              fallback: [{ providerAccount: "secondary", model: "claude-3-5-sonnet" }],
            },
          },
        },
      }, 0);

      const attempts: string[] = [];
      const adapter: InferenceAdapter = {
        id: "test-adapter",
        async bind(target: InferenceTarget) {
          attempts.push(target.providerAccount);
          throw new InferenceError({
            code: "invalid_request",
            message: "Bad request payload",
            providerAccount: target.providerAccount,
            model: target.model,
            retryable: false,
          });
        },
      };

      const runtime = new ProviderRuntime({ configStore, adapter });
      const snapshot = await runtime.createTurnSnapshot();
      const plan = await runtime.resolvePlan(snapshot, "text", "standard");

      for await (const _ of runtime.executeLanguage(plan, { messages: [] })) {}
      expect(attempts).toEqual(["primary"]);
    });
  });

  // ── QS-P7.2: Usage & Cost calculation ─────────────────────────────────────
  describe("QS-P7.2: Usage & Cost calculation", () => {
    it("calculates cost accurately from pricing metadata", () => {
      const usage = {
        inputTokens: 1_000,
        outputTokens: 500,
        cachedInputTokens: 200,
      };
      const pricing = {
        input: 2.5, // $2.50 per 1M tokens
        output: 10.0, // $10.00 per 1M tokens
        cachedInput: 1.25, // $1.25 per 1M tokens
      };

      const cost = calculateInferenceCost(usage, pricing);
      expect(cost).toBeCloseTo(0.0025 + 0.005 + 0.00025, 6);
    });

    it("returns undefined when pricing is unknown or absent (never 0)", () => {
      const usage = { inputTokens: 1000, outputTokens: 500 };
      expect(calculateInferenceCost(usage, undefined)).toBeUndefined();
    });
  });

  // ── QS-P7.3: Observability Events & Redaction ─────────────────────────────
  describe("QS-P7.3: Observability Events & Redaction", () => {
    it("emits lifecycle events and redacts secrets from event payloads", async () => {
      const configStore = new ProviderConfigStore(":memory:");
      await configStore.updateOverlay({
        providers: {
          openai: {
            adapter: "pi-ai",
            upstreamProvider: "openai",
            credential: { kind: "env", name: "sk-secret-key-12345" },
          },
        },
        modelAssignments: {
          text: { standard: { providerAccount: "openai", model: "gpt-4o" } },
        },
      }, 0);

      const emittedEvents: { event: string; payload: any }[] = [];
      const adapter: InferenceAdapter = {
        id: "test-adapter",
        async bind(target: InferenceTarget) {
          return {
            target,
            language: {
              async *stream() {
                yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } };
                yield { type: "finish", stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 10 } };
              },
            },
          } as unknown as BoundAdapter;
        },
      };

      const runtime = new ProviderRuntime({ configStore, adapter });
      const record = (event: string) => (payload: any) => emittedEvents.push({ event, payload });

      runtime.on("plan:resolved", record("plan:resolved"));
      runtime.on("inference:attempt", record("inference:attempt"));
      runtime.on("inference:success", record("inference:success"));

      const snapshot = await runtime.createTurnSnapshot();
      const plan = await runtime.resolvePlan(snapshot, "text", "standard");
      for await (const _ of runtime.executeLanguage(plan, { messages: [] })) {}

      expect(emittedEvents.some((e) => e.event === "plan:resolved")).toBe(true);
      expect(emittedEvents.some((e) => e.event === "inference:attempt")).toBe(true);
      expect(emittedEvents.some((e) => e.event === "inference:success")).toBe(true);

      // Verify no secrets appear in emitted event payloads
      const serialized = JSON.stringify(emittedEvents);
      expect(serialized).not.toContain("sk-secret-key-12345");
    });
  });

  // ── QS-P7.4: Concurrency & Mid-Session Credential Rotation ────────────────
  describe("QS-P7.4: Concurrency & Mid-Session Credential Rotation", () => {
    it("handles multiple concurrent ProviderRuntime instances without state contamination", async () => {
      const store1 = new ProviderConfigStore(":memory:");
      const store2 = new ProviderConfigStore(":memory:");

      await store1.updateOverlay({
        modelAssignments: { text: { standard: { providerAccount: "p1", model: "m1" } } },
      }, 0);
      await store2.updateOverlay({
        modelAssignments: { text: { standard: { providerAccount: "p2", model: "m2" } } },
      }, 0);

      const runtime1 = new ProviderRuntime({ configStore: store1 });
      const runtime2 = new ProviderRuntime({ configStore: store2 });

      const snap1 = await runtime1.createTurnSnapshot();
      const snap2 = await runtime2.createTurnSnapshot();

      expect(snap1.assignments.text?.standard?.model).toBe("m1");
      expect(snap2.assignments.text?.standard?.model).toBe("m2");
    });

    it("rotates credentials mid-session via lazy lease secret resolution", async () => {
      const credStore = new MemoryCredentialStore();
      await credStore.put("openai-key", { kind: "api_key", keyValue: "initial-key-v1" });

      const handle = await credStore.resolve({ kind: "seepient", id: "openai-key" });
      const lease = await handle.acquireLease();

      // Read initial key
      const secret1 = await lease.secret();
      expect(secret1.kind === "api_key" ? secret1.value : "").toBe("initial-key-v1");

      // Rotate credential in store
      await credStore.put("openai-key", { kind: "api_key", keyValue: "rotated-key-v2" });

      // Next lease secret call returns rotated key without recreating handle
      const secret2 = await lease.secret();
      expect(secret2.kind === "api_key" ? secret2.value : "").toBe("rotated-key-v2");

      lease.release();
    });
  });

  // ── QS-P7.5: Aggregate Image Adapter Composition ──────────────────────────
  describe("QS-P7.5: Aggregate Inference Adapter", () => {
    it("composes vendor backends for image operations", async () => {
      const { AggregateInferenceAdapter } = await import("../../../capabilities/inference/aggregate-adapter.js");
      expect(AggregateInferenceAdapter).toBeDefined();

      const adapter = new AggregateInferenceAdapter();
      expect(typeof adapter.bind).toBe("function");
    });
  });
});
