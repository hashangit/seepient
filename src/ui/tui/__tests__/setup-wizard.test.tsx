/**
 * 013 T021/T026 — SetupWizard tests: step order + skip rules, the main-model
 * gate, exactly-what-was-picked persistence, per-key extras saves.
 */
import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { SetupWizard, type SettingsAdapter } from "../setup-wizard.js";
import type { ProviderManagerApi, ManagerState, SaveResult } from "../../../transport/cli/provider-manager-api.js";

const ENTER = "\r";
const ESC = "\u001B";

const delay = (ms = 25) => new Promise<void>((r) => setTimeout(r, ms));
async function type(inst: { stdin: { write(s: string): void } }, s: string): Promise<void> {
  inst.stdin.write(s);
  await delay();
}

function freshState(): ManagerState {
  return {
    revision: 1,
    accounts: [],
    assignments: {} as any,
    models: [
      { id: "model-tool", upstreamProvider: "acme", displayName: "Model Tool", contextWindow: 100000,
        capabilities: { toolUse: true, streaming: true, vision: false },
        supportedReasoningLevels: ["none", "low"], provenance: "pi-catalog", reachableVia: ["acme"] },
    ],
    purposes: [
      { id: "text", label: "Text (writing)", tiered: true, requires: ["toolUse", "streaming"] },
      { id: "coding", label: "Coding", tiered: true, requires: ["toolUse", "streaming"] },
    ],
  };
}

function makeApi(state: ManagerState) {
  const setAssignment = vi.fn(async (_p: any, _t: any, target: any): Promise<SaveResult> => {
    state = { ...state, assignments: { ...state.assignments, text: { standard: target } } as any };
    return { ok: true, state };
  });
  const api: ProviderManagerApi = {
    getState: async () => state,
    saveAccount: async (input: any) => {
      state = { ...state, accounts: [...state.accounts, { id: input.accountId, upstreamProvider: input.upstreamProvider, credentialKind: "none", health: "unverified", modelCount: 1 }] };
      return { ok: true, state };
    },
    deleteAccount: async () => ({ ok: true, state }),
    setAssignment,
    clearAssignment: async () => ({ ok: true, state }),
    resolvePreview: async () => ({ selectedTarget: { providerAccount: "acme", model: "model-tool" }, via: "fallback-chain", failureTargets: [] }),
    probeAccount: async () => ({ accountId: "acme", authValid: true }),
    refreshModels: async () => ({ ok: true, discovered: [], state }),
    switchSessionModel: () => {},
    signInWithProvider: async () => ({ ok: true, state }),
    completeOAuthSignIn: async () => ({ ok: true, state }),
    logoutAccount: async () => ({ ok: true, state }),
    getAvailableOAuthFlows: async () => ["anthropic"],
  };
  return { api, setAssignment, get state() { return state; } };
}

function makeSettings() {
  const set = vi.fn(async (_k: string, _v: string) => {});
  const adapter: SettingsAdapter = { get: async () => undefined, set };
  return { adapter, set };
}

function setup(state: ManagerState) {
  const ctx = makeApi(state);
  const settings = makeSettings();
  const onFinish = vi.fn();
  const onExitSetup = vi.fn();
  const inst = render(
    <SetupWizard api={ctx.api} settings={settings.adapter} onFinish={onFinish} onExitSetup={onExitSetup} />,
  );
  return { inst, ctx, settings, onFinish, onExitSetup };
}

describe("SetupWizard — fresh flow (T021)", () => {
  it("connect → pick main model → skip → done; picked model is exactly what's written", async () => {
    const { inst, ctx, onFinish } = setup(freshState());
    await delay();
    expect(inst.lastFrame() ?? "").toContain("Continue");

    await type(inst, "1");            // welcome → connect (no accounts)
    expect(inst.lastFrame() ?? "").toContain("Add provider");

    await type(inst, "1");            // → AddAccount
    expect(inst.lastFrame() ?? "").toContain("Custom / local endpoint");
    await type(inst, ENTER);          // first upstream (acme)
    await type(inst, ENTER);          // default id
    await type(inst, "3");            // keyless → done
    await vi.waitFor(() => {
      expect(inst.lastFrame() ?? "").toContain("Account saved");
    });
    await type(inst, ESC);            // close AddAccount → back to connect menu
    await type(inst, "2");            // Continue → main

    await type(inst, ENTER);          // open picker (fresh: no main model)
    expect(inst.lastFrame() ?? "").toContain("Pick your main model");
    await type(inst, ENTER);          // model-tool → thinking step
    await type(inst, ENTER);          // accept default level → assign
    await vi.waitFor(() => {
      expect(ctx.setAssignment).toHaveBeenCalledWith(
        "text", "standard",
        { providerAccount: "acme", model: "model-tool", thinkingLevel: expect.any(String) },
      );
    });
    // exactly-what-was-picked: no hardcoded default id anywhere in the payload
    const call = ctx.setAssignment.mock.calls[0][2] as any;
    expect(call.model).toBe("model-tool");

    await type(inst, "2");            // slots → Skip
    await type(inst, "5");            // extras → Done
    await delay();
    expect(inst.lastFrame() ?? "").toContain("Setup complete");
    await type(inst, ENTER);          // [1] Finish
    await vi.waitFor(() => {
      expect(onFinish).toHaveBeenCalled();
    });
    expect(inst.lastFrame() ?? "").toContain("acme/model-tool");
  });
});

describe("SetupWizard — skip rules on a configured state (T021/T026)", () => {
  it("skips connect + main with ✓ notes and writes nothing", async () => {
    const state = freshState();
    state.accounts = [{ id: "acme", upstreamProvider: "acme", credentialKind: "none", health: "ok", modelCount: 1 }];
    (state.assignments as any).text = { standard: { providerAccount: "acme", model: "model-tool" } };
    const { inst, ctx, onFinish } = setup(state);
    await delay();
    await type(inst, "1"); // welcome → main (healthy account ⇒ connect skipped)
    const frame = inst.lastFrame() ?? "";
    expect(frame).toContain("already set");
    expect(frame).toContain("acme/model-tool");
    await type(inst, "1"); // Continue → slots
    await type(inst, "2"); // Skip
    await type(inst, "5"); // Done
    await delay();
    expect(inst.lastFrame() ?? "").toContain("Setup complete");
    await type(inst, ENTER); // Finish
    await vi.waitFor(() => expect(onFinish).toHaveBeenCalled());
    expect(ctx.setAssignment).not.toHaveBeenCalled();
  });
});

describe("SetupWizard — extras are per-key saves (T026, FR-006)", () => {
  it("saves each entered key individually and skips empties", async () => {
    const state = freshState();
    state.accounts = [{ id: "acme", upstreamProvider: "acme", credentialKind: "none", health: "ok", modelCount: 1 }];
    (state.assignments as any).text = { standard: { providerAccount: "acme", model: "model-tool" } };
    const { inst, settings } = setup(state);
    await delay();
    await type(inst, "1"); // → main
    await type(inst, "1"); // → slots
    await type(inst, "2"); // → extras
    await type(inst, "3"); // Web search group
    expect(inst.lastFrame() ?? "").toContain("tavily");
    await type(inst, "tvly-secret-1");
    await type(inst, ENTER); // save the one field → group done
    await vi.waitFor(() => {
      expect(settings.set).toHaveBeenCalledWith("search.tavilyApiKey", "tvly-secret-1");
    });
    expect(settings.set).toHaveBeenCalledTimes(1);
    expect(inst.lastFrame() ?? "").toContain("✓"); // group marked done
    await type(inst, "5"); // Done → summary
    await delay();
    expect(inst.lastFrame() ?? "").toContain("search.tavilyApiKey");
  });
});

describe("SetupWizard — exit & escape navigation (C4, SC-004)", () => {
  it("clean exit before any change goes straight out (no confirm)", async () => {
    const { inst, onExitSetup } = setup(freshState());
    await delay();
    await type(inst, "2"); // Exit setup (nothing dirty)
    expect(onExitSetup).toHaveBeenCalled();
  });

  it("navigates back one step on Escape across wizard steps (C4)", async () => {
    const state = freshState();
    state.accounts = [{ id: "acme", upstreamProvider: "acme", credentialKind: "none", health: "ok", modelCount: 1 }];
    (state.assignments as any).text = { standard: { providerAccount: "acme", model: "model-tool" } };
    const { inst } = setup(state);
    await delay();

    await type(inst, "1"); // welcome -> main
    expect(inst.lastFrame() ?? "").toContain("Main model already set");

    await type(inst, "1"); // main -> slots
    expect(inst.lastFrame() ?? "").toContain("job slots are unstaffed");

    await type(inst, "2"); // slots -> extras
    expect(inst.lastFrame() ?? "").toContain("Optional integrations");

    // Press Escape on extras -> should go back to slots
    await type(inst, ESC);
    expect(inst.lastFrame() ?? "").toContain("job slots are unstaffed");

    // Press Escape on slots -> should go back to main
    await type(inst, ESC);
    expect(inst.lastFrame() ?? "").toContain("Main model already set");
  });

  it("preserves unedited settings during wizard run (SC-004)", async () => {
    const state = freshState();
    state.accounts = [{ id: "acme", upstreamProvider: "acme", credentialKind: "none", health: "ok", modelCount: 1 }];
    (state.assignments as any).text = { standard: { providerAccount: "acme", model: "model-tool" } };
    const { inst, settings, onFinish } = setup(state);
    await delay();

    await type(inst, "1"); // welcome -> main
    await type(inst, "1"); // main -> slots
    await type(inst, "2"); // slots -> extras
    await type(inst, "5"); // extras -> summary (no extra keys entered)
    await delay();
    expect(inst.lastFrame() ?? "").toContain("Setup complete");
    await type(inst, ENTER); // [1] Finish
    await vi.waitFor(() => expect(onFinish).toHaveBeenCalled());

    // SC-004: settings.set was never called for unedited settings
    expect(settings.set).not.toHaveBeenCalled();
  });

  it("preserves unedited keys in real setting.json on disk during wizard run (SC-004 real-file)", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "seepient-sc004-"));
    const settingFile = path.join(tmpDir, "setting.json");

    // Pre-populate setting.json with existing custom settings
    const initialConfig = {
      "agent.systemPrompt": "Custom enterprise system prompt - DO NOT OVERWRITE",
      "network.proxy": "http://10.0.0.1:8080",
      "tui.theme": "dark-high-contrast",
    };
    fs.writeFileSync(settingFile, JSON.stringify(initialConfig, null, 2), "utf8");

    const diskSettings: SettingsAdapter = {
      get: (key: string) => {
        try {
          const raw = JSON.parse(fs.readFileSync(settingFile, "utf8"));
          return raw[key];
        } catch {
          return undefined;
        }
      },
      set: async (key: string, value: unknown) => {
        let current: any = {};
        try {
          current = JSON.parse(fs.readFileSync(settingFile, "utf8"));
        } catch {}
        current[key] = value;
        fs.writeFileSync(settingFile, JSON.stringify(current, null, 2), "utf8");
      },
    };

    const state = freshState();
    state.accounts = [{ id: "acme", upstreamProvider: "acme", credentialKind: "none", health: "ok", modelCount: 1 }];
    (state.assignments as any).text = { standard: { providerAccount: "acme", model: "model-tool" } };

    const onFinish = vi.fn();
    const onExitSetup = vi.fn();
    const inst = render(
      <SetupWizard
        api={makeApi(state).api}
        settings={diskSettings}
        onFinish={onFinish}
        onExitSetup={onExitSetup}
      />
    );
    await delay();

    await type(inst, "1"); // welcome -> main
    await type(inst, "1"); // main -> slots
    await type(inst, "2"); // slots -> extras
    await type(inst, "5"); // extras -> summary (skip entering keys)
    await delay();
    expect(inst.lastFrame() ?? "").toContain("Setup complete");
    await type(inst, ENTER); // finish
    await vi.waitFor(() => expect(onFinish).toHaveBeenCalled());

    // Verify disk content: original keys remain untouched
    const afterRun = JSON.parse(fs.readFileSync(settingFile, "utf8"));
    expect(afterRun["agent.systemPrompt"]).toBe("Custom enterprise system prompt - DO NOT OVERWRITE");
    expect(afterRun["network.proxy"]).toBe("http://10.0.0.1:8080");
    expect(afterRun["tui.theme"]).toBe("dark-high-contrast");

    // Clean up
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("blocks connect-step continue when 0 accounts are configured", async () => {
    const { inst } = setup(freshState());
    await delay();
    await type(inst, "1"); // welcome -> connect (0 accounts)
    expect(inst.lastFrame() ?? "").toContain("Add provider");
    expect(inst.lastFrame() ?? "").toContain("Continue (disabled — add first)");

    await type(inst, "2"); // Try to continue without account
    await delay();
    expect(inst.lastFrame() ?? "").toContain("Connect at least one provider account to continue");
  });
});
