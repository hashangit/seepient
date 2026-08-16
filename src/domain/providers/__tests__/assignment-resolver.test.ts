import { describe, it, expect } from "vitest";
import { resolveInvocationPlan, type TurnSnapshot } from "../assignment-resolver.js";
import { MemoryCredentialStore } from "../credentials/memory-credential-store.js";
import { DEFAULT_RETRY_POLICY } from "../../../foundations/schemas/provider-config.js";
import { SeepientError } from "../../../foundations/errors.js";

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
});
