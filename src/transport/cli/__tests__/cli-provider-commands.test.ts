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
});
