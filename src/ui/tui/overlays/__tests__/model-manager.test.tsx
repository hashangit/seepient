/**
 * 013 T011 — ModelManager dock tests (contract model-manager-dock.md).
 * Fake controller; interactive flows via the type() helper (see model-picker
 * tests for the ink setState-next-tick note).
 */
import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { ModelManager } from "../model-manager.js";
import type {
  ProviderManagerApi, ManagerState, SaveResult, DeleteResult,
} from "../../../../transport/cli/provider-manager-api.js";

import type { AvailableModel } from "../../../../domain/providers/model-catalog.js";

const ENTER = "\r";
const TAB = "\t";
const DOWN = "\u001B[B";
const ESC = "\u001B";

const delay = (ms = 20) => new Promise<void>((r) => setTimeout(r, ms));
async function type(inst: { stdin: { write(s: string): void } }, s: string): Promise<void> {
  inst.stdin.write(s);
  await delay();
}

function model(id: string, provider: string, over: Record<string, unknown> = {}): AvailableModel {
  return {
    id, upstreamProvider: provider, displayName: id, contextWindow: 200_000,
    capabilities: { toolUse: true, streaming: true, vision: false, ...((over as any).capabilities ?? {}) },
    supportedReasoningLevels: ["none", "low", "high"] as const, provenance: "pi-catalog" as const,
    reachableVia: [], ...over, ...( (over as any).capabilities ? { capabilities: { toolUse: true, streaming: true, vision: false, ...(over as any).capabilities } } : {}),
  } as AvailableModel;
}

function baseState(): ManagerState {
  return {
    revision: 7,
    accounts: [
      { id: "acme-main", upstreamProvider: "acme", credentialKind: "seepient", health: "ok", modelCount: 2 },
      { id: "acme-env", upstreamProvider: "other", credentialKind: "env", credentialDetail: "OTHER_KEY", health: "missing", modelCount: 1 },
    ],
    assignments: {
      text: { standard: { providerAccount: "acme-main", model: "model-tool", thinkingLevel: "low" } },
    } as any,
    models: [
      model("model-tool", "acme", { reachableVia: ["acme-main"] }),
      model("model-vision", "acme", { capabilities: { vision: true }, reachableVia: ["acme-main"] }),
      model("model-plain", "other", { reachableVia: ["acme-env"] }),
      model("gpt-x", "openai", {}),
    ],
    purposes: [
      { id: "text", label: "Text (writing)", tiered: true, requires: ["toolUse", "streaming"] },
      { id: "coding", label: "Coding", tiered: true, requires: ["toolUse", "streaming"] },
      { id: "vision", label: "Vision analysis", tiered: true, requires: ["toolUse", "streaming", "vision"] },
      { id: "media.image", label: "Image generation", tiered: false, requires: ["imageGenerate"] },
    ],
  };
}

function fakeApi(overrides?: {
  state?: ManagerState;
  getState?: () => Promise<ManagerState>;
  setAssignment?: any;
  clearAssignment?: any;
  resolvePreview?: any;
  deleteAccount?: any;
  signInWithProvider?: any;
  logoutAccount?: any;
  getAvailableOAuthFlows?: any;
}) {
  let state = overrides?.state ?? baseState();
  const api: ProviderManagerApi = {
    getState: overrides?.getState ?? (async () => state),
    saveAccount: async (input: any) => {
      state = { ...state, accounts: [...state.accounts, { id: input.accountId, upstreamProvider: input.upstreamProvider, credentialKind: "seepient", health: "unverified", modelCount: 0 }] };
      return { ok: true, state };
    },
    deleteAccount: overrides?.deleteAccount ?? (async (): Promise<DeleteResult> => ({ ok: true, state })),
    setAssignment: overrides?.setAssignment ?? (async (_p: any, _t: any, target: any): Promise<SaveResult> => {
      state = { ...state, assignments: { ...state.assignments, text: { standard: target } } as any };
      return { ok: true, state };
    }),
    clearAssignment: overrides?.clearAssignment ?? (async (): Promise<SaveResult> => ({ ok: true, state })),
    resolvePreview: overrides?.resolvePreview ?? (async () => ({
      selectedTarget: { providerAccount: "acme-main", model: "model-tool" },
      via: "fallback-chain" as const,
      failureTargets: [],
    })),
    probeAccount: async () => ({ accountId: "acme-main", authValid: true }),
    refreshModels: async () => ({ ok: true, discovered: ["m1"], state }),
    switchSessionModel: vi.fn(),
    signInWithProvider: overrides?.signInWithProvider ?? (async () => ({ ok: true, state })),
    completeOAuthSignIn: async () => ({ ok: true, state }),
    logoutAccount: overrides?.logoutAccount ?? (async () => ({ ok: true, state })),
    getAvailableOAuthFlows: overrides?.getAvailableOAuthFlows ?? (async () => ["anthropic", "openai-codex"]),
  };
  return { api, get state() { return state; } };
}

function setup(over?: Parameters<typeof fakeApi>[0], props: any = {}) {
  const ctx = fakeApi(over);
  const inst = render(
    <ModelManager api={ctx.api} activeAccount="acme-main" activeModel="model-tool" onClose={() => {}} {...props} />,
  );
  return { inst, ctx };
}

describe("Jobs board", () => {
  it("renders purposes from state (schema truth) with ●/○ and no stale literals", async () => {
    const { inst } = setup();
    await delay();
    const frame = inst.lastFrame() ?? "";
    expect(frame).toContain("Text (writing)");
    expect(frame).toContain("Coding");
    expect(frame).toContain("Image generation");
    expect(frame).not.toContain("image-generation");
    expect(frame).toContain("●");
    expect(frame).toContain("○");
  });

  it("flags capability-mismatched slots with ▲ and the reason", async () => {
    const state = baseState();
    (state.assignments as any).vision = { standard: { providerAccount: "acme-main", model: "model-tool" } };
    const { inst } = setup({ state });
    await delay();
    const frame = inst.lastFrame() ?? "";
    expect(frame).toContain("▲");
    expect(frame).toMatch(/image understanding/);
  });

  it("shows fallback targets on empty tiered slots via resolvePreview", async () => {
    const { inst } = setup({
      resolvePreview: async () => ({
        selectedTarget: { providerAccount: "acme-main", model: "model-tool" }, via: "fallback-chain" as const, failureTargets: [],
      }),
    });
    await delay();
    const frame = inst.lastFrame() ?? "";
    expect(frame).toMatch(/falls back/);
  });

  it("renders the numbered action bar on every tab (Tab cycles)", async () => {
    const { inst } = setup();
    await delay();
    expect(inst.lastFrame() ?? "").toContain("[1] Change model");
    await type(inst, TAB);
    expect(inst.lastFrame() ?? "").toContain("[1] Add provider");
    await type(inst, TAB);
    expect(inst.lastFrame() ?? "").toContain("[1] Refresh");
  });

  it("navigates tabs via Left/Right arrows", async () => {
    const { inst } = setup();
    await delay();
    expect(inst.lastFrame() ?? "").toContain("[1] Change model");
    await type(inst, "\u001B[C"); // Right arrow -> providers tab
    expect(inst.lastFrame() ?? "").toContain("[1] Add provider");
    await type(inst, "\u001B[D"); // Left arrow -> jobs tab
    expect(inst.lastFrame() ?? "").toContain("[1] Change model");
  });

  it("Enter on a slot opens the shared picker for that purpose; assigning saves and confirms", async () => {
    const setAssignment = vi.fn(async (_p: any, _t: any, target: any): Promise<SaveResult> => ({
      ok: true, state: { ...baseState(), assignments: { text: { standard: target } } as any },
    }));
    const { inst } = setup({ setAssignment });
    await delay();
    await type(inst, ENTER); // slot text·standard selected → picker
    let frame = inst.lastFrame() ?? "";
    expect(frame).toContain("Assign text·standard");
    await type(inst, ENTER); // thinking step
    await type(inst, ENTER); // accept default level → assign
    await vi.waitFor(() => {
      expect(setAssignment).toHaveBeenCalled();
    }, { timeout: 5000 });
    frame = inst.lastFrame() ?? "";
    expect(frame).toMatch(/applies next turn|assigned/);
  });

  it("clearing a slot reports applies-next-turn", async () => {
    const clearAssignment = vi.fn(async (_p: any, _t: any): Promise<SaveResult> => ({
      ok: true,
      state: baseState(),
    }));
    const { inst } = setup({ clearAssignment } as any);
    await delay();
    await type(inst, DOWN); // board action focus (single slot row selected)
    await type(inst, DOWN);
    await type(inst, "3"); // Clear slot
    await vi.waitFor(() => {
      expect(clearAssignment).toHaveBeenCalled();
    }, { timeout: 5000 });
    expect(inst.lastFrame() ?? "").toMatch(/applies next turn|cleared/);
  });
});

describe("Providers tab", () => {
  async function toProviders(inst: any) {
    await delay();
    await type(inst, TAB);
  }

  it("renders accounts with badges and not-connected teasers", async () => {
    const { inst } = setup();
    await toProviders(inst);
    const frame = inst.lastFrame() ?? "";
    expect(frame).toContain("acme-main");
    expect(frame).toContain("ENV OTHER_KEY");
    expect(frame).toContain("Not connected");
  });

  it("test account shows the probe result inline", async () => {
    const { inst } = setup();
    await toProviders(inst);
    await type(inst, DOWN);
    await type(inst, DOWN); // focus actions
    await type(inst, "2"); // Test account
    await delay();
    expect(inst.lastFrame() ?? "").toMatch(/auth ok|✓/);
  });

  it("blocked remove lists referencing slots; force confirm removes", async () => {
    let forced = false;
    const deleteAccount = vi.fn(async (_id: string, o?: { force?: boolean }): Promise<DeleteResult> => {
      if (!o?.force) return { ok: false, blocked: true, referencingSlots: ["text·standard"] };
      forced = true;
      return { ok: true, state: baseState() };
    });
    const { inst } = setup({ deleteAccount });
    await toProviders(inst);
    await type(inst, DOWN);
    await type(inst, DOWN);
    await type(inst, "4"); // Remove account (blocked)
    await delay();
    expect(inst.lastFrame() ?? "").toContain("text·standard");
    await type(inst, "1"); // Remove anyway
    await vi.waitFor(() => {
      expect(forced).toBe(true);
    }, { timeout: 5000 });
  });

  it("add provider opens the shared AddAccount and saves through the api", async () => {
    const { inst, ctx } = setup();
    await toProviders(inst);
    await type(inst, DOWN);
    await type(inst, DOWN);
    await type(inst, "1"); // Add provider → AddAccount choose screen
    expect(inst.lastFrame() ?? "").toContain("Custom / local endpoint");
    await type(inst, ENTER); // pick first upstream (acme? filtered list uses state upstreams)
    await type(inst, ENTER); // id
    await type(inst, "3"); // keyless
    await vi.waitFor(() => {
      expect(ctx.state.accounts.length).toBe(3);
    }, { timeout: 5000 });
  });
});

describe("resilience + feedback", () => {
  it("state-load failure renders a retry banner, never a blank screen", async () => {
    let fail = true;
    const { inst } = setup({
      getState: async () => {
        if (fail) throw new Error("storage exploded");
        return baseState();
      },
    });
    await delay();
    const frame = inst.lastFrame() ?? "";
    expect(frame).toContain("storage exploded");
    expect(frame).toContain("[1] Retry");
  });

  it("assignment errors surface in the footer, never silently", async () => {
    const setAssignment = vi.fn(async (): Promise<SaveResult> => ({
      ok: false, error: { code: "conflict", message: "changed elsewhere" },
    }));
    const { inst } = setup({ setAssignment });
    await delay();
    await type(inst, ENTER);
    await type(inst, ENTER);
    await type(inst, ENTER);
    await vi.waitFor(() => {
      expect(inst.lastFrame() ?? "").toContain("changed elsewhere");
    }, { timeout: 5000 });
  });

  it("session switch marks temporary and closes", async () => {
    const onClose = vi.fn();
    const { inst, ctx } = setup(undefined, { onClose });
    await delay();
    await type(inst, ENTER);  // picker
    await type(inst, TAB);    // focus picker action bar
    await type(inst, "2");    // Try for this session
    await delay(40);
    expect(ctx.api.switchSessionModel).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});

describe("OAuth Sign-in & Badges (Phase 9 US7)", () => {
  it("renders ◐ sign-in badge for oauth accounts", async () => {
    const state = baseState();
    state.accounts.push({
      id: "anthropic-sub",
      upstreamProvider: "anthropic",
      credentialKind: "oauth",
      health: "ok",
      modelCount: 4,
    });
    const { inst } = setup({ state }, { initialTab: "providers" });
    await delay();
    const frame = inst.lastFrame() ?? "";
    expect(frame).toContain("anthropic-sub");
    expect(frame).toContain("◐ sign-in · ok");
  });

  it("renders [1] Sign in again for expired oauth accounts", async () => {
    const state = baseState();
    state.accounts = [{
      id: "anthropic-sub",
      upstreamProvider: "anthropic",
      credentialKind: "oauth",
      health: "expired",
      modelCount: 4,
    }];
    const { inst } = setup({ state }, { initialTab: "providers" });
    await delay();
    const frame = inst.lastFrame() ?? "";
    expect(frame).toContain("[1] Sign in again");
  });

  it("opens SignInFlow screen on initialSignIn prop and shows device code", async () => {
    const signInWithProvider = vi.fn(async (_u: string, cb: any) => {
      cb.onDeviceCode?.({ userCode: "ABCD-1234", verificationUrl: "https://auth.example.com", expiresInMs: 60000 });
      return new Promise<{ ok: true; state: ManagerState }>(() => {});
    });
    const { inst } = setup({ signInWithProvider } as any, { initialSignIn: "anthropic" });
    await delay();
    const frame = inst.lastFrame() ?? "";
    expect(frame).toContain("Sign in with anthropic");
    expect(frame).toContain("ABCD-1234");
    expect(frame).toContain("https://auth.example.com");
  });

  it("FR-030: flags referencing slots with ▲ credential missing when assigned account credential is missing", async () => {
    const state = baseState();
    // acme-main has text.standard assigned in baseState; set its health to missing (e.g. after logout or deleted credential)
    const acct = state.accounts.find((a) => a.id === "acme-main")!;
    acct.health = "missing";

    const { inst } = setup({ state }, { initialTab: "jobs" });
    await delay();
    const frame = inst.lastFrame() ?? "";
    expect(frame).toContain("▲");
    expect(frame).toContain("credential missing");
  });
});
