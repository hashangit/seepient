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
    .option("--upstream <upstream>", "Upstream provider name (e.g. openai, anthropic, google)")
    .action(async (providerId, opts) => {
      const runtime = getDefaultProviderRuntime();
      const api = createProviderManagerApi(runtime);
      const state = await api.getState();
      const existing = state.accounts.find((a) => a.id === providerId);
      const upstreamProvider = opts.upstream ?? (existing ? existing.upstreamProvider : providerId);

      const snapshot = await runtime.createTurnSnapshot();
      const rawExisting = snapshot.config.providers?.[providerId];

      if (opts.key) {
        const res = await api.saveAccount({
          accountId: providerId,
          upstreamProvider,
          credential: { mode: "paste", keyValue: opts.key },
          baseUrl: rawExisting?.baseUrl,
          compat: rawExisting?.compat,
          allowPrivate: rawExisting?.ssrfAllowPrivate,
        });
        if (!res.ok) {
          const hintText = res.error.hint ? ` (${res.error.hint})` : "";
          console.error(chalk.red(`Error (${res.error.code}): ${res.error.message}${hintText}`));
          process.exit(1);
        }
        console.log(chalk.green(`✓ Successfully configured credential for provider account "${providerId}"`));
        return;
      }

      if (opts.envVar) {
        const res = await api.saveAccount({
          accountId: providerId,
          upstreamProvider,
          credential: { mode: "env", varName: opts.envVar },
          baseUrl: rawExisting?.baseUrl,
          compat: rawExisting?.compat,
          allowPrivate: rawExisting?.ssrfAllowPrivate,
        });
        if (!res.ok) {
          const hintText = res.error.hint ? ` (${res.error.hint})` : "";
          console.error(chalk.red(`Error (${res.error.code}): ${res.error.message}${hintText}`));
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
      const { isOAuthSupported } = await import("../../../domain/providers/oauth-service.js");
      const hasOAuth = isOAuthSupported(upstreamProvider);

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
            upstreamProvider,
            credential: { mode: "paste", keyValue: key },
            baseUrl: rawExisting?.baseUrl,
            compat: rawExisting?.compat,
            allowPrivate: rawExisting?.ssrfAllowPrivate,
          });
          if (!res.ok) {
            const hintText = res.error.hint ? ` (${res.error.hint})` : "";
            console.error(chalk.red(`Error (${res.error.code}): ${res.error.message}${hintText}`));
            process.exit(1);
          }
          console.log(chalk.green(`✓ Successfully configured API key for "${providerId}"`));
        } else if (choice === "2") {
          const envName = (await rl.question("Environment variable name: ")).trim();
          if (!envName) {
            console.error(chalk.red("Error: Environment variable name cannot be empty."));
            process.exit(1);
          }
          const res = await api.saveAccount({
            accountId: providerId,
            upstreamProvider,
            credential: { mode: "env", varName: envName },
            baseUrl: rawExisting?.baseUrl,
            compat: rawExisting?.compat,
            allowPrivate: rawExisting?.ssrfAllowPrivate,
          });
          if (!res.ok) {
            const hintText = res.error.hint ? ` (${res.error.hint})` : "";
            console.error(chalk.red(`Error (${res.error.code}): ${res.error.message}${hintText}`));
            process.exit(1);
          }
          console.log(chalk.green(`✓ Successfully configured env credential (${envName}) for "${providerId}"`));
        } else if (choice === "3" && hasOAuth) {
          console.log(chalk.cyan(`\nInitiating sign-in with ${upstreamProvider}...`));
          const res = await api.signInWithProvider(upstreamProvider, {
            preferredAccountId: providerId,
            onDeviceCode: (info) => {
              console.log(chalk.bold(`\n1. Visit: ${chalk.underline.cyan(info.verificationUrl)}`));
              console.log(chalk.bold(`2. Enter code: ${chalk.yellow.bold(info.userCode)}`));
              console.log(chalk.dim(`\nWaiting for authorization (expires in ${Math.round(info.expiresInMs / 60000)}m)...`));
            },
            onBrowserOpen: (url, instructions) => {
              console.log(chalk.bold(`\nComplete authorization in your browser:`));
              console.log(chalk.underline.cyan(url));
              console.log(chalk.dim(`\nIf you're not already signed in, the page will ask you to sign in or create an account first — then approve access.`));
              if (instructions) console.log(chalk.dim(instructions));
              console.log(chalk.dim(`\nWaiting for callback...`));
            },
            onWaiting: () => {
              process.stdout.write(chalk.dim("."));
            },
          });
          if (!res.ok) {
            const hintText = res.error.hint ? ` (${res.error.hint})` : "";
            console.error(chalk.red(`\nSign-in failed (${res.error.code}): ${res.error.message}${hintText}`));
            process.exit(1);
          }
          console.log(chalk.green(`\n✓ Successfully signed in with ${upstreamProvider} as "${providerId}"`));
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
    .option("--json", "Output result as JSON")
    .action(async (providerId, opts) => {
      const runtime = getDefaultProviderRuntime();
      const api = createProviderManagerApi(runtime);
      const res = await api.logoutAccount(providerId);
      if (opts.json) {
        console.log(JSON.stringify(res, null, 2));
        if (!res.ok) process.exitCode = 1;
        return;
      }
      if (!res.ok) {
        if (res.error.code === "unconfigured_provider" || res.error.code === "credential_unavailable") {
          console.log(chalk.yellow(`Provider "${providerId}" is not configured.`));
          return;
        }
        const hintText = res.error.hint ? ` (${res.error.hint})` : "";
        console.error(chalk.red(`Error (${res.error.code}): ${res.error.message}${hintText}`));
        process.exit(1);
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
