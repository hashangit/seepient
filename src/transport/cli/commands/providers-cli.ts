/**
 * Seepient CLI — `seepient providers` commands
 *
 * Implements `providers list`, `providers add`, `providers edit`, and `providers remove`.
 * Includes `--pool language|image` two-pool filtering over accounts (Rev 4.2 S19).
 */

import { Command } from "commander";
import chalk from "chalk";
import { ProviderConfigStore } from "../../../domain/providers/config-store/provider-config-store.js";
import { getSyncBuiltinCatalog } from "../../../domain/providers/model-catalog.js";
import { validateEndpointUrl } from "../../http/ssrf-validator.js";

export function registerProvidersCommands(program: Command): void {
  const providersCmd = program.command("providers").description("Manage configured provider accounts and credentials");

  providersCmd
    .command("list")
    .description("List all configured provider accounts")
    .option("--pool <pool>", "Filter by capability pool: language | image")
    .action(async (opts) => {
      const store = new ProviderConfigStore();
      const config = await store.getEffectiveConfig();
      const accounts = (config.providers || {}) as Record<string, any>;
      const catalog = getSyncBuiltinCatalog();

      const accountEntries = Object.entries(accounts);
      if (accountEntries.length === 0) {
        console.log(chalk.yellow("No provider accounts configured."));
        console.log(chalk.dim("Add one with: seepient providers add <id> --upstream <provider>"));
        return;
      }

      console.log(chalk.bold.cyan("\nConfigured Provider Accounts:"));

      for (const [id, acc] of accountEntries) {
        const upstream = acc.upstreamProvider ?? id;
        const matchingModels = catalog.filter((m: any) => m.upstreamProvider === upstream || m.upstreamProvider === id);

        const hasLanguage = matchingModels.length === 0 || matchingModels.some((m: any) => m.capabilities.toolUse !== false);
        const hasImage = matchingModels.some((m: any) => (m.capabilities as any).imageGenerate || (m.capabilities as any).imageEdit);

        if (opts.pool === "language" && !hasLanguage) continue;
        if (opts.pool === "image" && !hasImage) continue;

        const credKind = acc.credential?.kind ?? "none";
        const credStatus = credKind !== "none" ? chalk.green("✓ configured") : chalk.yellow("○ unconfigured");

        console.log(`\n  ${chalk.bold(id)} (${upstream})`);
        console.log(`    Adapter:    ${acc.adapter ?? "pi-ai"}`);
        console.log(`    Credential: ${credKind} [${credStatus}]`);
        if (acc.baseUrl) {
          console.log(`    Endpoint:   ${acc.baseUrl} ${acc.ssrfAllowPrivate ? chalk.dim("(private allowed)") : ""}`);
        }
        console.log(`    Models:     ${matchingModels.length} available in catalog`);
      }
      console.log("");
    });

  providersCmd
    .command("add <id>")
    .description("Add a new provider account")
    .requiredOption("--upstream <provider>", "Upstream provider (e.g. openai, anthropic, google, ollama)")
    .option("--adapter <adapter>", "Inference adapter to use", "pi-ai")
    .option("--url <baseUrl>", "Custom base URL endpoint")
    .option("--allow-private", "Allow connecting to private / localhost IP addresses (for Ollama/vLLM)")
    .option("--compat <compat>", "Wire protocol compatibility (openai | anthropic | google | openai-responses)")
    .action(async (id, opts) => {
      if (opts.url) {
        const check = await validateEndpointUrl(opts.url, { ssrfAllowPrivate: !!opts.allowPrivate });
        if (!check.valid) {
          console.log(chalk.red(`Error: ${check.error}`));
          process.exit(1);
        }
      }

      const store = new ProviderConfigStore();
      const overlay = await store.getOverlay();

      const newAccount = {
        adapter: opts.adapter,
        upstreamProvider: opts.upstream,
        baseUrl: opts.url,
        ssrfAllowPrivate: !!opts.allowPrivate,
        compat: opts.compat,
        credential: { kind: "none" as const },
      };

      await store.updateOverlay(
        {
          providers: {
            [id]: newAccount,
          } as any,
        },
        overlay.revision,
      );

      console.log(chalk.green(`✓ Successfully added provider account "${id}"`));
    });

  providersCmd
    .command("edit <id>")
    .description("Edit an existing provider account")
    .option("--upstream <provider>", "Upstream provider")
    .option("--url <baseUrl>", "Custom base URL endpoint")
    .option("--allow-private", "Allow connecting to private / localhost IP addresses")
    .option("--compat <compat>", "Wire protocol compatibility")
    .action(async (id, opts) => {
      const store = new ProviderConfigStore();
      const overlay = await store.getOverlay();
      const existing = (overlay.patch?.providers as any)?.[id];

      if (!existing) {
        console.log(chalk.red(`Error: Provider account "${id}" not found.`));
        process.exit(1);
      }

      if (opts.url) {
        const check = await validateEndpointUrl(opts.url, {
          ssrfAllowPrivate: opts.allowPrivate !== undefined ? !!opts.allowPrivate : existing.ssrfAllowPrivate,
        });
        if (!check.valid) {
          console.log(chalk.red(`Error: ${check.error}`));
          process.exit(1);
        }
      }

      const updated = {
        ...existing,
        ...(opts.upstream ? { upstreamProvider: opts.upstream } : {}),
        ...(opts.url !== undefined ? { baseUrl: opts.url } : {}),
        ...(opts.allowPrivate !== undefined ? { ssrfAllowPrivate: !!opts.allowPrivate } : {}),
        ...(opts.compat ? { compat: opts.compat } : {}),
      };

      await store.updateOverlay(
        {
          providers: {
            [id]: updated,
          } as any,
        },
        overlay.revision,
      );

      console.log(chalk.green(`✓ Successfully updated provider account "${id}"`));
    });

  providersCmd
    .command("remove <id>")
    .description("Remove a provider account")
    .action(async (id) => {
      const store = new ProviderConfigStore();
      const overlay = await store.getOverlay();
      if (!(overlay.patch?.providers as any)?.[id]) {
        console.log(chalk.yellow(`Provider "${id}" is not configured.`));
        return;
      }

      await store.updateOverlay(
        {
          providers: {
            [id]: null,
          } as any,
        },
        overlay.revision,
      );

      console.log(chalk.green(`✓ Successfully removed provider account "${id}"`));
    });
}
