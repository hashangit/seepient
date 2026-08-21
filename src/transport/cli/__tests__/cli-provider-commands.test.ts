import { describe, it, expect, vi } from "vitest";
import { Command } from "commander";
import { registerAuthCommands } from "../commands/auth-cli.js";
import { registerProvidersCommands } from "../commands/providers-cli.js";
import { registerModelsCommands } from "../commands/models-cli.js";

describe("CLI Provider Subcommands Integration (QS-P6.1 & QS-P6.2)", () => {
  it("registers auth, providers, and models commands with expected options", () => {
    const program = new Command();
    registerAuthCommands(program);
    registerProvidersCommands(program);
    registerModelsCommands(program);

    const authCmd = program.commands.find((c) => c.name() === "auth");
    expect(authCmd).toBeDefined();
    expect(authCmd?.commands.map((c) => c.name())).toEqual(
      expect.arrayContaining(["login", "logout", "issue-token"]),
    );

    const providersCmd = program.commands.find((c) => c.name() === "providers");
    expect(providersCmd).toBeDefined();
    expect(providersCmd?.commands.map((c) => c.name())).toEqual(
      expect.arrayContaining(["list", "add", "edit", "remove"]),
    );

    const modelsCmd = program.commands.find((c) => c.name() === "models");
    expect(modelsCmd).toBeDefined();
    expect(modelsCmd?.commands.map((c) => c.name())).toEqual(
      expect.arrayContaining(["browse", "resolve", "set", "list", "fallback", "status", "check", "probe", "discover"]),
    );

    const generateCmd = program.commands.find((c) => c.name() === "generate");
    expect(generateCmd).toBeDefined();
    expect(generateCmd?.commands.map((c) => c.name())).toEqual(
      expect.arrayContaining(["image"]),
    );
  });

  it("browse command supports --json output flag", () => {
    const program = new Command();
    registerModelsCommands(program);
    const modelsCmd = program.commands.find((c) => c.name() === "models");
    const browseCmd = modelsCmd?.commands.find((c) => c.name() === "browse");
    expect(browseCmd).toBeDefined();
    expect(browseCmd?.options.map((o) => o.long)).toContain("--json");
    expect(browseCmd?.options.map((o) => o.long)).toContain("--reachable-only");
  });

  it("resolve command supports --json output flag", () => {
    const program = new Command();
    registerModelsCommands(program);
    const modelsCmd = program.commands.find((c) => c.name() === "models");
    const resolveCmd = modelsCmd?.commands.find((c) => c.name() === "resolve");
    expect(resolveCmd).toBeDefined();
    expect(resolveCmd?.options.map((o) => o.long)).toContain("--json");
  });

  it("providers add supports --credential flag", () => {
    const program = new Command();
    registerProvidersCommands(program);
    const providersCmd = program.commands.find((c) => c.name() === "providers");
    const addCmd = providersCmd?.commands.find((c) => c.name() === "add");
    expect(addCmd).toBeDefined();
    expect(addCmd?.options.map((o) => o.long)).toContain("--credential");
  });

  it("auth login supports --env-var flag", () => {
    const program = new Command();
    registerAuthCommands(program);
    const authCmd = program.commands.find((c) => c.name() === "auth");
    const loginCmd = authCmd?.commands.find((c) => c.name() === "login");
    expect(loginCmd).toBeDefined();
    expect(loginCmd?.options.map((o) => o.long)).toContain("--env-var");
  });

  it("resolves coding and media.image purposes correctly via ProviderManagerApi (hermetic)", async () => {
    const { createProviderManagerApi } = await import("../provider-manager-api.js");
    const { ProviderRuntime } = await import("../../../domain/providers/provider-runtime.js");
    const { ProviderConfigStore } = await import("../../../domain/providers/config-store/provider-config-store.js");
    const { MemoryCredentialStore } = await import("../../../domain/providers/credentials/memory-credential-store.js");

    const configStore = new ProviderConfigStore(":memory:");
    const credentialStore = new MemoryCredentialStore();
    const runtime = new ProviderRuntime({ configStore, credentialStore });
    const api = createProviderManagerApi(runtime);

    // Save test account
    await api.saveAccount({
      accountId: "cli-test-openai",
      upstreamProvider: "openai",
      credential: { mode: "paste", keyValue: "sk-test" },
    });

    // Set text.standard, coding.standard, and media.image
    const assignRes1 = await api.setAssignment("text", "standard", {
      providerAccount: "cli-test-openai",
      model: "gpt-4o",
    });
    expect(assignRes1.ok).toBe(true);

    const assignRes2 = await api.setAssignment("media.image", null, {
      providerAccount: "cli-test-openai",
      model: "dall-e-3",
      fallback: [{ providerAccount: "cli-test-openai", model: "dall-e-2" }],
    });
    expect(assignRes2.ok).toBe(true);

    // Verify resolvePreview for coding falls back to text or resolves
    const codingPreview = await api.resolvePreview("coding", "standard");
    expect((codingPreview as any).selectedTarget?.providerAccount).toBe("cli-test-openai");

    // Verify resolvePreview for media.image resolves to dall-e-3
    const mediaPreview = await api.resolvePreview("media.image", undefined);
    expect((mediaPreview as any).selectedTarget?.model).toBe("dall-e-3");

    // Verify fallback is preserved in state
    const state = await api.getState();
    expect((state.assignments as any).media?.image?.fallback).toEqual([
      { providerAccount: "cli-test-openai", model: "dall-e-2" },
    ]);

    // Verify providers edit with mode: preserve keeps credential
    const editRes = await api.saveAccount({
      accountId: "cli-test-openai",
      upstreamProvider: "openai",
      credential: { mode: "preserve" },
      baseUrl: "https://api.openai.com/v1",
    });
    expect(editRes.ok).toBe(true);
    if (editRes.ok) {
      const acct = editRes.state.accounts.find((a) => a.id === "cli-test-openai");
      expect(acct?.credentialKind).toBe("seepient");
      expect(acct?.health).toBe("ok");
    }
  });

  it("parses models resolve media.image command argv correctly", async () => {
    const program = new Command();
    registerModelsCommands(program);
    const modelsCmd = program.commands.find((c) => c.name() === "models");
    const resolveCmd = modelsCmd?.commands.find((c) => c.name() === "resolve");
    expect(resolveCmd).toBeDefined();

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await program.parseAsync(["node", "test", "models", "resolve", "media.image", "--json"]);
      // Should have output JSON or handled resolution without unhandled syntax error
      expect(logSpy).toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
    }
  });
});
