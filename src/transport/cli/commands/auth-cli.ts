/**
 * Seepient CLI — `seepient auth` commands
 *
 * Implements `auth login`, `auth logout`, and `auth issue-token`.
 * Refactored onto ProviderManagerApi controller (013 US8 / R15).
 */

import { Command } from "commander";
import chalk from "chalk";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { generateApiKey, KeyScope } from "../../auth/auth.js";
import { getDefaultProviderRuntime } from "../../../domain/providers/provider-runtime.js";
import { createProviderManagerApi } from "../provider-manager-api.js";

export function registerAuthCommands(program: Command): void {
  const authCmd = program.command("auth").description("Manage provider credentials and server API keys");

  authCmd
    .command("login <provider>")
    .description("Configure credentials for a provider account")
    .option("--key <apiKey>", "API key for the provider")
    .option("--env-var <name>", "Environment variable name containing the API key")
    .action(async (providerId, opts) => {
      const runtime = getDefaultProviderRuntime();
      const api = createProviderManagerApi(runtime);

      if (opts.key) {
        const res = await api.saveAccount({
          accountId: providerId,
          upstreamProvider: providerId,
          credential: { mode: "paste", keyValue: opts.key },
        });
        if (!res.ok) {
          console.error(chalk.red(`Error (${res.error.code}): ${res.error.message}`));
          process.exit(1);
        }
        console.log(chalk.green(`✓ Successfully configured credential for provider account "${providerId}"`));
        return;
      }

      if (opts.envVar) {
        const res = await api.saveAccount({
          accountId: providerId,
          upstreamProvider: providerId,
          credential: { mode: "env", varName: opts.envVar },
        });
        if (!res.ok) {
          console.error(chalk.red(`Error (${res.error.code}): ${res.error.message}`));
          process.exit(1);
        }
        console.log(chalk.green(`✓ Successfully configured env credential (${opts.envVar}) for provider account "${providerId}"`));
        return;
      }

      // Non-interactive guard (FR-032)
      if (!process.stdin.isTTY) {
        console.error(chalk.red(`Error: --key or --env-var is required in non-interactive mode.`));
        console.error(chalk.dim(`Usage: seepient auth login <id> --key <key> OR seepient auth login <id> --env-var <NAME>`));
        process.exit(1);
      }

      // Interactive TTY menu
      const flows = await api.getAvailableOAuthFlows();
      const hasOAuth = flows.includes(providerId.toLowerCase());

      console.log(chalk.bold.cyan(`\nAuthenticate provider account "${providerId}":`));
      console.log(`  [1] Paste API key`);
      console.log(`  [2] Use environment variable`);
      if (hasOAuth) {
        console.log(`  [3] Sign in with provider (OAuth / subscription)`);
      }

      const rl = readline.createInterface({ input, output });
      try {
        const choice = (await rl.question("\nChoose an option: ")).trim();
        if (choice === "1") {
          const key = (await rl.question("API key: ")).trim();
          if (!key) {
            console.error(chalk.red("Error: API key cannot be empty."));
            process.exit(1);
          }
          const res = await api.saveAccount({
            accountId: providerId,
            upstreamProvider: providerId,
            credential: { mode: "paste", keyValue: key },
          });
          if (!res.ok) {
            console.error(chalk.red(`Error (${res.error.code}): ${res.error.message}`));
            process.exit(1);
          }
          console.log(chalk.green(`✓ Successfully configured API key for "${providerId}"`));
        } else if (choice === "2") {
          const envName = (await rl.question("Environment variable name: ")).trim();
          if (!envName) {
            console.error(chalk.red("Error: Variable name cannot be empty."));
            process.exit(1);
          }
          const res = await api.saveAccount({
            accountId: providerId,
            upstreamProvider: providerId,
            credential: { mode: "env", varName: envName },
          });
          if (!res.ok) {
            console.error(chalk.red(`Error (${res.error.code}): ${res.error.message}`));
            process.exit(1);
          }
          console.log(chalk.green(`✓ Successfully configured environment variable "${envName}" for "${providerId}"`));
        } else if (choice === "3" && hasOAuth) {
          console.log(chalk.cyan(`\nInitiating sign-in flow for ${providerId}…`));
          const res = await api.signInWithProvider(providerId, {
            onDeviceCode: ({ userCode, verificationUrl }) => {
              console.log(chalk.bold(`1. Open this URL in your browser: `) + chalk.cyan.underline(verificationUrl));
              console.log(chalk.bold(`2. Enter confirmation code: `) + chalk.yellow.bold(userCode));
              console.log(chalk.dim(`Waiting for authorization in browser…`));
            },
            onBrowserOpen: (url) => {
              console.log(chalk.bold(`Complete authentication in browser: `) + chalk.cyan.underline(url));
              console.log(chalk.dim(`Waiting for browser callback…`));
            },
            onWaiting: () => {
              console.log(chalk.dim(`Waiting for authorization…`));
            },
          });
          if (!res.ok) {
            console.error(chalk.red(`\nError (${res.error.code}): ${res.error.message}`));
            process.exit(1);
          }
          console.log(chalk.green(`\n✓ Successfully signed in with ${providerId}`));
        } else {
          console.error(chalk.red("Invalid option."));
          process.exit(1);
        }
      } finally {
        rl.close();
      }
    });

  authCmd
    .command("logout <provider>")
    .description("Remove credentials for a provider account")
    .action(async (providerId) => {
      const runtime = getDefaultProviderRuntime();
      const api = createProviderManagerApi(runtime);
      const res = await api.logoutAccount(providerId);
      if (!res.ok) {
        console.log(chalk.yellow(`Provider "${providerId}" is not configured.`));
        return;
      }
      console.log(chalk.green(`✓ Successfully removed credential for provider account "${providerId}"`));
    });

  authCmd
    .command("issue-token")
    .description("Issue a new server API key token (stores SHA-256 hash at rest)")
    .option("--scope <scope>", "Key scope: agent:run, agent:read, provider:read, provider:admin, admin", "provider:admin")
    .option("--label <label>", "Label for this key", "cli-issued")
    .action((opts) => {
      const validScopes: KeyScope[] = ["agent:run", "agent:read", "provider:read", "provider:admin", "admin"];
      if (!validScopes.includes(opts.scope as KeyScope)) {
        console.log(chalk.red(`Invalid scope "${opts.scope}". Must be one of: ${validScopes.join(", ")}`));
        process.exit(1);
      }

      const result = generateApiKey([opts.scope as KeyScope], { label: opts.label });
      console.log(chalk.bold.green("✓ New API token generated:"));
      console.log(chalk.cyan(`\n  ${result.rawKey}\n`));
      console.log(chalk.yellow("⚠️  Save this key now — only its SHA-256 hash is saved to disk and it cannot be retrieved again."));
      console.log(chalk.dim(`Scopes: [${result.scopes.join(", ")}] | Label: ${result.label}`));
    });
}
