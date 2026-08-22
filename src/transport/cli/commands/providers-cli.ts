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
    const varName = raw.slice(4).trim();
    if (!varName) {
      console.error(chalk.red('Error: Missing environment variable name in --credential env:VAR_NAME'));
      process.exit(1);
    }
    return { mode: "env", varName };
  }
  console.error(chalk.red(`Error: Invalid credential mode "${raw}". Expected "env:VAR_NAME" or "none".`));
  process.exit(1);
}

export function registerProvidersCommands(program: Command): void {
  const providersCmd = program.command("providers").description("Manage configured provider accounts and credentials");

  providersCmd
    .command("list")
    .description("List all configured provider accounts")
    .option("--pool <pool>", "Filter by capability pool: language | image")
    .option("--json", "Output provider accounts as JSON")
    .action(async (opts) => {
      const runtime = getDefaultProviderRuntime();
      const api = createProviderManagerApi(runtime);
      const state = await api.getState();

      if (opts.json) {
        let accounts = state.accounts;
        if (opts.pool) {
          accounts = accounts.filter((acc) => {
            const matchingModels = state.models.filter(
              (m) => m.upstreamProvider === acc.upstreamProvider || m.upstreamProvider === acc.id,
            );
            const hasLanguage = matchingModels.length === 0 || matchingModels.some((m) => m.capabilities.toolUse !== false);
            const hasImage = matchingModels.some((m: any) => m.capabilities?.imageGenerate || m.capabilities?.imageEdit);
            return opts.pool === "language" ? hasLanguage : hasImage;
          });
        }
        console.log(JSON.stringify(accounts, null, 2));
        return;
      }

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
          : acc.health === "expired"
          ? chalk.red("⚠ expired")
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
    .option("--url <baseUrl>", "Custom base URL endpoint")
    .option("--allow-private", "Allow connecting to private / localhost IP addresses (for Ollama/vLLM)")
    .option("--compat <compat>", "Wire protocol compatibility (openai | anthropic | google | openai-responses)")
    .option("--json", "Output result as JSON")
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

      if (opts.json) {
        console.log(JSON.stringify(res, null, 2));
        if (!res.ok) process.exitCode = 1;
        return;
      }

      if (!res.ok) {
        const hintText = res.error.hint ? ` (${res.error.hint})` : "";
        console.error(chalk.red(`Error (${res.error.code}): ${res.error.message}${hintText}`));
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
    .option("--json", "Output result as JSON")
    .action(async (id, opts) => {
      const runtime = getDefaultProviderRuntime();
      const api = createProviderManagerApi(runtime);
      const state = await api.getState();
      const existing = state.accounts.find((a) => a.id === id);

      if (!existing) {
        if (opts.json) {
          console.log(JSON.stringify({ ok: false, error: { code: "account_not_found", message: `Provider account "${id}" not found.` } }, null, 2));
          process.exitCode = 1;
          return;
        }
        console.error(chalk.red(`Error: Provider account "${id}" not found.`));
        process.exit(1);
      }

      const snapshot = await runtime.createTurnSnapshot();
      const existingEntry = snapshot.config.providers?.[id];

      const credential = opts.credential ? parseCredentialMode(opts.credential) : { mode: "preserve" as const };
      const res = await api.saveAccount({
        accountId: id,
        upstreamProvider: opts.upstream ?? existing.upstreamProvider,
        credential,
        baseUrl: opts.url !== undefined ? opts.url : existingEntry?.baseUrl,
        allowPrivate: opts.allowPrivate !== undefined ? Boolean(opts.allowPrivate) : existingEntry?.ssrfAllowPrivate,
        compat: opts.compat !== undefined ? opts.compat : existingEntry?.compat,
      });

      if (opts.json) {
        console.log(JSON.stringify(res, null, 2));
        if (!res.ok) process.exitCode = 1;
        return;
      }

      if (!res.ok) {
        const hintText = res.error.hint ? ` (${res.error.hint})` : "";
        console.error(chalk.red(`Error (${res.error.code}): ${res.error.message}${hintText}`));
        process.exit(1);
      }

      console.log(chalk.green(`✓ Successfully updated provider account "${id}"`));
    });

  providersCmd
    .command("remove <id>")
    .description("Remove a provider account")
    .option("--force", "Force remove even if referenced by active model slots")
    .option("--json", "Output result as JSON")
    .action(async (id, opts) => {
      const runtime = getDefaultProviderRuntime();
      const api = createProviderManagerApi(runtime);

      const res = await api.deleteAccount(id, { force: !!opts.force });
      if (opts.json) {
        console.log(JSON.stringify(res, null, 2));
        if (!res.ok) process.exitCode = 1;
        return;
      }

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

      const hintText = res.error.hint ? ` (${res.error.hint})` : "";
      console.error(chalk.red(`Error (${res.error.code}): ${res.error.message}${hintText}`));
      process.exit(1);
    });
}
