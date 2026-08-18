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
      expect.arrayContaining(["set", "list", "fallback", "status", "check", "probe", "discover"]),
    );

    const generateCmd = program.commands.find((c) => c.name() === "generate");
    expect(generateCmd).toBeDefined();
    expect(generateCmd?.commands.map((c) => c.name())).toEqual(
      expect.arrayContaining(["image"]),
    );
  });
});
