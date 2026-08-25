import { describe, it, expect } from "vitest";
import { resolveInvocationPlan, type TurnSnapshot } from "../assignment-resolver.js";
import { MemoryCredentialStore } from "../credentials/memory-credential-store.js";
import { DEFAULT_RETRY_POLICY } from "../../../foundations/schemas/provider-config.js";
import { SeepientError, InferenceError } from "../../../foundations/errors.js";

describe("AssignmentResolver (QS-P4.5)", () => {
  const credentialStore = new MemoryCredentialStore();

  const mockSnapshot: TurnSnapshot = {
    revision: 1,
    createdAt: new Date().toISOString(),
    catalog: [],
    config: {
      schemaVersion: 2,
      revision: 1,
      updatedAt: new Date().toISOString(),
      providers: {
        "primary-openai": {
          adapter: "pi-ai",
          upstreamProvider: "openai",
          credential: { kind: "none" },
        },
        "backup-anthropic": {
          adapter: "pi-ai",
          upstreamProvider: "anthropic",
          credential: { kind: "none" },
        },
      },
      modelAssignments: {
        text: {
          standard: {
            providerAccount: "primary-openai",
            model: "gpt-4o",
            thinkingLevel: "medium",
            fallback: [
              {
                providerAccount: "backup-anthropic",
                model: "claude-3-7-sonnet",
                thinkingLevel: "low",
              },
            ],
          },
          complex: {
            providerAccount: "backup-anthropic",
            model: "claude-3-7-sonnet",
          },
        },
      },
      retryPolicy: DEFAULT_RETRY_POLICY,
    },
    assignments: {
      text: {
        standard: {
          providerAccount: "primary-openai",
          model: "gpt-4o",
          thinkingLevel: "medium",
          fallback: [
            {
              providerAccount: "backup-anthropic",
              model: "claude-3-7-sonnet",
              thinkingLevel: "low",
            },
          ],
        },
        complex: {
          providerAccount: "backup-anthropic",
          model: "claude-3-7-sonnet",
        },
      },
    },
  };

  it("resolves selectedTarget and ordered failureTargets from purpose and tier", async () => {
    const plan = await resolveInvocationPlan(mockSnapshot, credentialStore, "text", "standard");

    expect(plan.selectedTarget.providerAccount).toBe("primary-openai");
    expect(plan.selectedTarget.model).toBe("gpt-4o");
    expect(plan.selectedTarget.thinkingLevel).toBe("medium");

    expect(plan.failureTargets.length).toBe(1);
    expect(plan.failureTargets[0].providerAccount).toBe("backup-anthropic");
    expect(plan.failureTargets[0].model).toBe("claude-3-7-sonnet");
    expect(plan.failureTargets[0].thinkingLevel).toBe("low");
  });

  it("applies missing-tier selection fallback (efficient falls back to standard)", async () => {
    const plan = await resolveInvocationPlan(mockSnapshot, credentialStore, "text", "efficient");

    expect(plan.selectedTarget.providerAccount).toBe("primary-openai");
    expect(plan.selectedTarget.model).toBe("gpt-4o");
  });

  it("applies explicit per-step override cleanly", async () => {
    const plan = await resolveInvocationPlan(
      mockSnapshot,
      credentialStore,
      "text",
      "standard",
      {
        providerAccount: "backup-anthropic",
        model: "claude-3-5-haiku",
        thinkingLevel: "high",
      },
    );

    expect(plan.selectedTarget.providerAccount).toBe("backup-anthropic");
    expect(plan.selectedTarget.model).toBe("claude-3-5-haiku");
    expect(plan.selectedTarget.thinkingLevel).toBe("high");
    expect(plan.failureTargets).toEqual([]);
  });

  it("throws UNCONFIGURED_PURPOSE when purpose cannot be resolved", async () => {
    await expect(
      resolveInvocationPlan(mockSnapshot, credentialStore, "image-generation"),
    ).rejects.toThrow(SeepientError);
  });

  it("rejects non-tool-use models assigned to text purpose (QS-P5.1)", async () => {
    const snap: TurnSnapshot = {
      ...mockSnapshot,
      catalog: [
        {
          id: "no-tool-model",
          upstreamProvider: "openai",
          displayName: "No Tools",
          contextWindow: 4096,
          capabilities: { toolUse: false, streaming: true, vision: false },
          provenance: "seepient-curated",
        },
      ],
    };

    await expect(
      resolveInvocationPlan(snap, credentialStore, "text", "standard", {
        providerAccount: "primary-openai",
        model: "no-tool-model",
      }),
    ).rejects.toThrow(/does not support tool use/);
  });

  it("rejects unsupported thinking levels instead of clamping, allowing minimal when supported (QS-P5.1)", async () => {
    const snap: TurnSnapshot = {
      ...mockSnapshot,
      catalog: [
        {
          id: "claude-model",
          upstreamProvider: "anthropic",
          displayName: "Claude",
          contextWindow: 200_000,
          capabilities: { toolUse: true, streaming: true, vision: true },
          supportedReasoningLevels: ["none", "minimal", "low", "high"],
          provenance: "seepient-curated",
        },
      ],
    };

    // 1. "minimal" is supported -> succeeds
    const validPlan = await resolveInvocationPlan(snap, credentialStore, "text", "standard", {
      providerAccount: "backup-anthropic",
      model: "claude-model",
      thinkingLevel: "minimal",
    });
    expect(validPlan.selectedTarget.thinkingLevel).toBe("minimal");

    // 2. "max" is not supported -> throws unsupported_thinking_level error
    try {
      await resolveInvocationPlan(snap, credentialStore, "text", "standard", {
        providerAccount: "backup-anthropic",
        model: "claude-model",
        thinkingLevel: "max",
      });
      expect.unreachable("Should have thrown");
    } catch (err: any) {
      expect(err).toBeInstanceOf(InferenceError);
      expect(err.code).toBe("unsupported_thinking_level");
      expect(err.message).toMatch(/does not support thinking level "max"/);
    }
  });

  it("skips invalid or incapable failureTargets without failing primary target", async () => {
    const snap: TurnSnapshot = {
      ...mockSnapshot,
      catalog: [
        {
          id: "gpt-4o",
          upstreamProvider: "openai",
          displayName: "GPT-4o",
          contextWindow: 128_000,
          capabilities: { toolUse: true, streaming: true, vision: true },
          supportedReasoningLevels: ["none", "medium"],
          provenance: "seepient-curated",
        },
        {
          id: "no-tool-fallback",
          upstreamProvider: "anthropic",
          displayName: "No Tools",
          contextWindow: 4096,
          capabilities: { toolUse: false, streaming: true, vision: false },
          provenance: "seepient-curated",
        },
      ],
      assignments: {
        text: {
          standard: {
            providerAccount: "primary-openai",
            model: "gpt-4o",
            fallback: [
              {
                providerAccount: "backup-anthropic",
                model: "no-tool-fallback",
              },
            ],
          },
        },
      },
    };

    const plan = await resolveInvocationPlan(snap, credentialStore, "text", "standard");
    expect(plan.selectedTarget.model).toBe("gpt-4o");
    expect(plan.failureTargets.length).toBe(0); // Incapable fallback was safely skipped
  });

  describe("FR-002 (WS5 / QS-P4): Zero-Day Model Passthrough & Override Admission", () => {
    it("admits unindexed model override with nearest-id warnings without mutating catalog snapshot", async () => {
      const snap: TurnSnapshot = {
        ...mockSnapshot,
        catalog: [
          {
            id: "gpt-5.6-terra",
            upstreamProvider: "openai",
            displayName: "GPT-5.6 Terra",
            contextWindow: 272000,
            capabilities: { toolUse: true, streaming: true, vision: true },
            provenance: "pi-catalog",
          },
          {
            id: "gpt-5.6-sol",
            upstreamProvider: "openai",
            displayName: "GPT-5.6 Sol",
            contextWindow: 272000,
            capabilities: { toolUse: true, streaming: true, vision: true },
            provenance: "pi-catalog",
          },
        ],
      };

      const catalogLengthBefore = snap.catalog.length;

      // Override with an unindexed zero-day model id
      const plan = await resolveInvocationPlan(snap, credentialStore, "text", "standard", {
        model: "gpt-5.6-custom-zeroday",
      });

      // Target is admitted
      expect(plan.selectedTarget.model).toBe("gpt-5.6-custom-zeroday");
      expect(plan.selectedTarget.providerAccount).toBe("primary-openai");

      // Warnings contain nearest candidate suggestions (capped at 3)
      expect(plan.warnings).toBeDefined();
      expect(plan.warnings?.length).toBe(1);
      expect(plan.warnings?.[0]).toMatch(/Unknown model "gpt-5.6-custom-zeroday"/);
      expect(plan.warnings?.[0]).toMatch(/gpt-5.6-terra/);

      // Snapshot catalog remains immutable
      expect(snap.catalog.length).toBe(catalogLengthBefore);
      expect(snap.catalog.find((m) => m.id === "gpt-5.6-custom-zeroday")).toBeUndefined();
    });

    it("ranks candidates by similarity distance relative to modelId", async () => {
      const snap: TurnSnapshot = {
        ...mockSnapshot,
        catalog: [
          {
            id: "completely-unrelated-model",
            upstreamProvider: "openai",
            displayName: "Unrelated",
            contextWindow: 128000,
            capabilities: { toolUse: true, streaming: true, vision: true },
            provenance: "pi-catalog",
          },
          {
            id: "gpt-5.6-terra-preview",
            upstreamProvider: "openai",
            displayName: "Terra Preview",
            contextWindow: 272000,
            capabilities: { toolUse: true, streaming: true, vision: true },
            provenance: "pi-catalog",
          },
          {
            id: "gpt-5.6-terra",
            upstreamProvider: "openai",
            displayName: "Terra",
            contextWindow: 272000,
            capabilities: { toolUse: true, streaming: true, vision: true },
            provenance: "pi-catalog",
          },
        ],
      };

      // When overriding with "gpt-5.6-tera" (typo of terra), gpt-5.6-terra is ranked before completely-unrelated-model
      const plan = await resolveInvocationPlan(snap, credentialStore, "text", "standard", {
        model: "gpt-5.6-tera",
      });

      expect(plan.warnings).toBeDefined();
      expect(plan.warnings?.[0]).toContain("gpt-5.6-terra, gpt-5.6-terra-preview");
    });
  });
});


