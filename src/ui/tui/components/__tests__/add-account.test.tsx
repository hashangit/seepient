/**
 * 013 T009 — AddAccount flow tests (contract model-manager-dock.md §5).
 */
import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { AddAccount } from "../add-account.js";
import type { AccountInput, UiError } from "../../../../transport/cli/provider-manager-api.js";

const DOWN = "\u001B[B";
const ENTER = "\r";
const ESC = "\u001B";
const TAB = "\t";
const BACKSPACE = "\u007F";

const delay = (ms = 50) => new Promise<void>((r) => setTimeout(r, ms));
async function type(inst: { stdin: { write(s: string): void } }, s: string): Promise<void> {
  inst.stdin.write(s);
  await delay(50);
}

const UPSTREAMS = [
  { id: "anthropic", modelCount: 64 },
  { id: "google", modelCount: 88 },
  { id: "openai", modelCount: 96 },
  { id: "openrouter", modelCount: 300 },
];

function setup(over: Partial<Parameters<typeof AddAccount>[0]> = {}) {
  const onSaveAccount = vi.fn(async (_i: AccountInput): Promise<UiError | null> => null);
  const onClose = vi.fn();
  const props = {
    upstreams: UPSTREAMS,
    existingIds: ["openai"],
    onSaveAccount,
    onClose,
    ...over,
  };
  const inst = render(<AddAccount {...props} />);
  return { inst, props };
}

describe("AddAccount — provider selection", () => {
  it("lists catalog-derived upstreams with model counts and the pinned Custom entry", () => {
    const { inst } = setup();
    const frame = inst.lastFrame() ?? "";
    expect(frame).toContain("anthropic");
    expect(frame).toContain("openrouter");
    expect(frame).toContain("300");
    expect(frame).toContain("+ Custom / local endpoint");
    expect(frame).toContain("[1] Connect provider");
    expect(frame).toContain("[2] Custom / local endpoint");
  });

  it("searches upstreams; prefillUpstream starts filtered", async () => {
    const { inst } = setup({ prefillUpstream: "google" });
    const frame = inst.lastFrame() ?? "";
    expect(frame).toContain("google");
    expect(frame).not.toContain("anthropic");
  });

  it("selecting a catalog upstream goes straight to account id with the upstream as default", async () => {
    const { inst } = setup();
    await type(inst, ENTER); // anthropic selected
    await vi.waitFor(() => {
      const frame = inst.lastFrame() ?? "";
      expect(frame).toContain("Account id");
      expect(frame).toContain("anthropic"); // default value shown
    }, { timeout: 5000 });
  });
});

describe("AddAccount — account id", () => {
  it("suggests a suffix on collision with an existing id", async () => {
    const { inst } = setup();
    await type(inst, "openai"); // filter to the openai upstream
    await vi.waitFor(() => {
      expect(inst.lastFrame() ?? "").toContain("openai▏");
      expect(inst.lastFrame() ?? "").toContain("▸ openai");
      expect(inst.lastFrame() ?? "").not.toContain("anthropic");
    }, { timeout: 5000 });
    await type(inst, ENTER);    // select it — collides with existingIds ["openai"]
    await vi.waitFor(() => {
      expect(inst.lastFrame() ?? "").toContain("openai-2");
    }, { timeout: 5000 });
  });

  it("accepts a typed id (Enter advances to the credential menu)", async () => {
    const { inst } = setup();
    await type(inst, ENTER); // anthropic, default id
    await vi.waitFor(() => {
      expect(inst.lastFrame() ?? "").toContain("Account id");
    }, { timeout: 5000 });
    await type(inst, ENTER); // accept id
    await vi.waitFor(() => {
      const frame = inst.lastFrame() ?? "";
      expect(frame).toContain("[1] Paste API key");
      expect(frame).toContain("[2] Use an environment variable");
      expect(frame).toContain("[3] No key");
    }, { timeout: 5000 });
  });

  it("P0-1 regression: blocks advancing on colliding account id and shows error", async () => {
    const { inst } = setup({ existingIds: ["anthropic"] });
    await type(inst, ENTER); // select anthropic -> defaultId is "anthropic-2"
    await vi.waitFor(() => {
      expect(inst.lastFrame() ?? "").toContain("Account id");
    }, { timeout: 5000 });
    await type(inst, "anthropic"); // type colliding account id "anthropic"
    await type(inst, ENTER); // try to submit colliding id

    await vi.waitFor(() => {
      const frame = inst.lastFrame() ?? "";
      expect(frame).toContain('Account "anthropic" already exists');
      expect(frame).toContain("Account id"); // stays on account id phase
      expect(frame).not.toContain("[1] Paste API key"); // does NOT advance to credential phase
    }, { timeout: 5000 });
  });
});

describe("AddAccount — credential modes", () => {
  it("paste mode masks input and submits the key to onSaveAccount", async () => {
    const { inst, props } = setup();
    await type(inst, ENTER); // upstream
    await vi.waitFor(() => {
      expect(inst.lastFrame() ?? "").toContain("Account id");
    }, { timeout: 5000 });
    await type(inst, ENTER); // id
    await vi.waitFor(() => {
      expect(inst.lastFrame() ?? "").toContain("[1] Paste API key");
    }, { timeout: 5000 });
    await type(inst, "1");   // paste
    await type(inst, "s");
    await type(inst, "k");
    await vi.waitFor(() => {
      const masked = inst.lastFrame() ?? "";
      expect(masked).toContain("**");
      expect(masked).not.toMatch(/> sk/); // raw key never rendered in the input line
    }, { timeout: 5000 });
    await type(inst, ENTER); // submit
    await vi.waitFor(() => {
      expect(props.onSaveAccount).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: "anthropic",
          upstreamProvider: "anthropic",
          credential: { mode: "paste", keyValue: "sk" },
        }),
      );
    });
    await vi.waitFor(() => {
      expect(inst.lastFrame() ?? "").toContain("✓");
    }, { timeout: 5000 });
  });

  it("env mode takes a variable NAME only", async () => {
    const { inst, props } = setup();
    await type(inst, ENTER);
    await vi.waitFor(() => {
      expect(inst.lastFrame() ?? "").toContain("Account id");
    }, { timeout: 5000 });
    await type(inst, ENTER);
    await vi.waitFor(() => {
      expect(inst.lastFrame() ?? "").toContain("[2] Use an environment variable");
    }, { timeout: 5000 });
    await type(inst, "2");
    await type(inst, "MY");
    await type(inst, "_KEY");
    await type(inst, ENTER);
    await vi.waitFor(() => {
      expect(props.onSaveAccount).toHaveBeenCalledWith(
        expect.objectContaining({ credential: { mode: "env", varName: "MY_KEY" } }),
      );
    });
  });

  it("keyless mode saves without any secret", async () => {
    const { inst, props } = setup();
    await type(inst, ENTER);
    await vi.waitFor(() => {
      expect(inst.lastFrame() ?? "").toContain("Account id");
    }, { timeout: 5000 });
    await type(inst, ENTER);
    await vi.waitFor(() => {
      expect(inst.lastFrame() ?? "").toContain("[3] No key");
    }, { timeout: 5000 });
    await type(inst, "3");
    await vi.waitFor(() => {
      expect(props.onSaveAccount).toHaveBeenCalledWith(
        expect.objectContaining({ credential: { mode: "none" } }),
      );
    });
  });

  it("a failed save shows the error and persists nothing more", async () => {
    const failSave = vi.fn(async (): Promise<UiError> => ({ code: "credential_unavailable", message: "keychain denied" }));
    const { inst, props } = setup({ onSaveAccount: failSave });
    await type(inst, ENTER);
    await vi.waitFor(() => {
      expect(inst.lastFrame() ?? "").toContain("Account id");
    }, { timeout: 5000 });
    await type(inst, ENTER);
    await vi.waitFor(() => {
      expect(inst.lastFrame() ?? "").toContain("[1] Paste API key");
    }, { timeout: 5000 });
    await type(inst, "1");
    await type(inst, "x");
    await type(inst, ENTER);
    await vi.waitFor(() => {
      expect(props.onSaveAccount).toHaveBeenCalled();
    });
    await vi.waitFor(() => {
      expect(inst.lastFrame() ?? "").toContain("keychain denied");
      expect(props.onClose).not.toHaveBeenCalled();
    }, { timeout: 5000 });
  });
});

describe("AddAccount — custom endpoint path", () => {
  it("asks for baseUrl + compat with a local-address confirm", async () => {
    const { inst, props } = setup();
    await type(inst, TAB);  // focus the action bar
    await type(inst, "2");  // Custom / local endpoint action
    await vi.waitFor(() => {
      expect(inst.lastFrame() ?? "").toContain("Base URL");
    }, { timeout: 5000 });
    await type(inst, "http://127.0.0.1:11434/v1");
    await type(inst, ENTER);
    await vi.waitFor(() => {
      expect(inst.lastFrame() ?? "").toContain("[1] Allow local address");
    }, { timeout: 5000 });
    await type(inst, "1");
    await type(inst, ENTER); // accept default compat (none)
    await vi.waitFor(() => {
      expect(inst.lastFrame() ?? "").toContain("Account id");
    }, { timeout: 5000 });
    await type(inst, ENTER); // id default "custom"
    await vi.waitFor(() => {
      expect(inst.lastFrame() ?? "").toContain("[3] No key");
    }, { timeout: 5000 });
    await type(inst, "3");   // keyless
    await vi.waitFor(() => {
      expect(props.onSaveAccount).toHaveBeenCalledWith(
        expect.objectContaining({
          baseUrl: "http://127.0.0.1:11434/v1",
          allowPrivate: true,
          credential: { mode: "none" },
        }),
      );
    });
  });

  it("cancel on the local-address confirm aborts the save", async () => {
    const { inst, props } = setup();
    await type(inst, TAB);
    await type(inst, "2");
    await vi.waitFor(() => {
      expect(inst.lastFrame() ?? "").toContain("Base URL");
    }, { timeout: 5000 });
    await type(inst, "http://192.168.1.5:8000/v1");
    await type(inst, ENTER);
    await vi.waitFor(() => {
      expect(inst.lastFrame() ?? "").toContain("[2] Cancel");
    }, { timeout: 5000 });
    await type(inst, "2"); // cancel
    expect(props.onSaveAccount).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(inst.lastFrame() ?? "").toContain("Base URL");
    }, { timeout: 5000 });
  });
});

describe("AddAccount — navigation", () => {
  it("Esc pops one level at a time and never loses entered state silently", async () => {
    const { inst, props } = setup();
    await type(inst, ENTER); // id phase
    await vi.waitFor(() => {
      expect(inst.lastFrame() ?? "").toContain("Account id");
    }, { timeout: 5000 });
    await type(inst, ESC);   // back to choose
    await vi.waitFor(() => {
      expect(inst.lastFrame() ?? "").toContain("Custom / local endpoint");
      expect(props.onClose).not.toHaveBeenCalled();
    }, { timeout: 5000 });
    await type(inst, ESC);   // choose → close
    await vi.waitFor(() => {
      expect(props.onClose).toHaveBeenCalled();
    }, { timeout: 5000 });
  });

  it("arrow keys move selection in the provider list", async () => {
    const { inst } = setup();
    await type(inst, DOWN); // google
    await type(inst, ENTER);
    await vi.waitFor(() => {
      expect(inst.lastFrame() ?? "").toContain("google");
    }, { timeout: 5000 });
  });

  it("offers [4] Sign in with provider for supported OAuth upstreams", async () => {
    const onSignIn = vi.fn();
    const canSignIn = (u: string) => ["anthropic", "openai", "github", "kimi", "xai"].includes(u.toLowerCase());
    const { inst } = setup({
      prefillUpstream: "openai",
      canSignIn,
      onSignIn,
    });
    // From choose prefilled with openai → enter
    await type(inst, ENTER); // id phase
    await vi.waitFor(() => {
      expect(inst.lastFrame() ?? "").toContain("Account id");
    }, { timeout: 5000 });
    await type(inst, ENTER); // credential phase
    await vi.waitFor(() => {
      const frame = inst.lastFrame() ?? "";
      expect(frame).toContain("[4] Sign in with provider");
    }, { timeout: 5000 });

    await type(inst, "4");
    expect(onSignIn).toHaveBeenCalledWith("openai");
  });
});
