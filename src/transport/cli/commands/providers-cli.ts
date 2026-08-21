/**
 * Seepient CLI — `seepient providers` commands
 *
 * Implements `providers list`, `providers add`, `providers edit`, and `providers remove`.
 * Includes `--pool language|image` two-pool filtering over accounts.
 * Refactored onto ProviderManagerApi controller (013 US8 / R15).
 */

import { Command } from "commander";
import chalk from "chalk";
import { getDefaultProviderRuntime } from "../../../domain/providers/provider-runtime.js";
import { createProviderManagerApi, type AccountInput } from "../provider-manager-api.js";

function parseCredentialMode(raw?: string): AccountInput["credential"] {
  if (!raw || raw === "none") {
    return { mode: "none" };
  }
  if (raw.startsWith("env:")) {
    return { mode: "env", varName: raw.slice(4) };
  }
  return { mode: "none" };
}

export function registerProvidersCommands(program: Command): void {
  const providersCmd = program.command("providers").description("Manage configured provider accounts and credentials");

  providersCmd
    .command("list")
    .description("List all configured provider accounts")
    .option("--pool <pool>", "Filter by capability pool: language | image")
    .action(async (opts) => {
      const runtime = getDefaultProviderRuntime();
      const api = createProviderManagerApi(runtime);
      const state = await api.getState();

      if (state.accounts.length === 0) {
        console.log(chalk.yellow("No provider accounts configured."));
        console.log(chalk.dim("Add one with: seepient providers add <id> --upstream <provider>"));
        return;
      }

      console.log(chalk.bold.cyan("\nConfigured Provider Accounts:"));

      for (const acc of state.accounts) {
        const matchingModels = state.models.filter(
          (m) => m.upstreamProvider === acc.upstreamProvider || m.upstreamProvider === acc.id,
        );

        const hasLanguage = matchingModels.length === 0 || matchingModels.some((m) => m.capabilities.toolUse !== false);
        const hasImage = matchingModels.some((m: any) => m.capabilities?.imageGenerate || m.capabilities?.imageEdit);

        if (opts.pool === "language" && !hasLanguage) continue;
        if (opts.pool === "image" && !hasImage) continue;

        const credStatus = acc.health === "ok"
          ? chalk.green("✓ configured")
          : acc.health === "missing"
          ? chalk.red("⚠ missing credential")
          : chalk.yellow("○ unconfigured");

        console.log(`\n  ${chalk.bold(acc.id)} (${acc.upstreamProvider})`);
        console.log(`    Adapter:    pi-ai`);
        console.log(`    Credential: ${acc.credentialKind} [${credStatus}]`);
        if (acc.baseUrl) {
          console.log(`    Endpoint:   ${acc.baseUrl}`);
        }
        console.log(`    Models:     ${acc.modelCount} available in catalog`);
      }
      console.log("");
    });

  providersCmd
    .command("add <id>")
    .description("Add a new provider account")
    .requiredOption("--upstream <provider>", "Upstream provider (e.g. openai, anthropic, google, ollama)")
    .option("--credential <mode>", "Credential mode: env:VAR_NAME or none", "none")
    .option("--adapter <adapter>", "Inference adapter to use", "pi-ai")
    .option("--url <baseUrl>", "Custom base URL endpoint")
    .option("--allow-private", "Allow connecting to private / localhost IP addresses (for Ollama/vLLM)")
    .option("--compat <compat>", "Wire protocol compatibility (openai | anthropic | google | openai-responses)")
    .action(async (id, opts) => {
      const runtime = getDefaultProviderRuntime();
      const api = createProviderManagerApi(runtime);

      const credential = parseCredentialMode(opts.credential);
      const res = await api.saveAccount({
        accountId: id,
        upstreamProvider: opts.upstream,
        credential,
        baseUrl: opts.url,
        allowPrivate: !!opts.allowPrivate,
        compat: opts.compat,
      });

      if (!res.ok) {
        console.error(chalk.red(`Error (${res.error.code}): ${res.error.message}`));
        process.exit(1);
      }

      console.log(chalk.green(`✓ Successfully added provider account "${id}"`));
    });

  providersCmd
    .command("edit <id>")
    .description("Edit an existing provider account")
    .option("--upstream <provider>", "Upstream provider")
    .option("--credential <mode>", "Credential mode: env:VAR_NAME or none")
    .option("--url <baseUrl>", "Custom base URL endpoint")
    .option("--allow-private", "Allow connecting to private / localhost IP addresses")
    .option("--compat <compat>", "Wire protocol compatibility")
    .action(async (id, opts) => {
      const runtime = getDefaultProviderRuntime();
      const api = createProviderManagerApi(runtime);
      const state = await api.getState();
      const existing = state.accounts.find((a) => a.id === id);

      if (!existing) {
        console.error(chalk.red(`Error: Provider account "${id}" not found.`));
        process.exit(1);
      }

      const credential = opts.credential ? parseCredentialMode(opts.credential) : { mode: "preserve" as const };
      const res = await api.saveAccount({
        accountId: id,
        upstreamProvider: opts.upstream ?? existing.upstreamProvider,
        credential,
        baseUrl: opts.url ?? existing.baseUrl,
        allowPrivate: opts.allowPrivate !== undefined ? !!opts.allowPrivate : undefined,
        compat: opts.compat,
      });

      if (!res.ok) {
        console.error(chalk.red(`Error (${res.error.code}): ${res.error.message}`));
        process.exit(1);
      }

      console.log(chalk.green(`✓ Successfully updated provider account "${id}"`));
    });

  providersCmd
    .command("remove <id>")
    .description("Remove a provider account")
    .option("--force", "Force remove even if referenced by active model slots")
    .action(async (id, opts) => {
      const runtime = getDefaultProviderRuntime();
      const api = createProviderManagerApi(runtime);

      const res = await api.deleteAccount(id, { force: !!opts.force });
      if (res.ok) {
        console.log(chalk.green(`✓ Successfully removed provider account "${id}"`));
        return;
      }

      if ("blocked" in res) {
        console.error(
          chalk.red(
            `Error: Account "${id}" is referenced by active slot(s): ${res.referencingSlots.join(", ")}. Use --force to remove anyway.`,
          ),
        );
        process.exit(1);
      }

      console.error(chalk.red(`Error (${res.error.code}): ${res.error.message}`));
      process.exit(1);
    });
}
