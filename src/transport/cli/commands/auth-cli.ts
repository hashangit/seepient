/**
 * Seepient CLI — `seepient auth` commands
 *
 * Implements `auth login`, `auth logout`, and `auth issue-token`.
 */

import { Command } from "commander";
import chalk from "chalk";
import { generateApiKey, revokeApiKey, KeyScope } from "../../auth/auth.js";
import { ProviderConfigStore } from "../../../domain/providers/config-store/provider-config-store.js";
import { MemoryCredentialStore } from "../../../domain/providers/credentials/memory-credential-store.js";
import { CompositeCredentialStore } from "../../../domain/providers/credentials/composite-credential-store.js";

export function registerAuthCommands(program: Command): void {
  const authCmd = program.command("auth").description("Manage provider credentials and server API keys");

  authCmd
    .command("login <provider>")
    .description("Configure credentials for a provider account")
    .option("--key <apiKey>", "API key for the provider")
    .action(async (providerId, opts) => {
      let apiKey = opts.key;
      if (!apiKey) {
        console.log(chalk.red(`Error: --key is required in non-interactive mode for login`));
        process.exit(1);
      }

      // Save secret securely in CredentialStore
      const credStore = new CompositeCredentialStore();
      await credStore.put(
        providerId,
        { kind: "api_key", keyValue: apiKey },
        { source: "disk" },
      );

      // Point provider account overlay to the secure CredentialRef
      const store = new ProviderConfigStore();
      const snapshot = await store.getOverlay();
      const existing = (snapshot.patch?.providers as any)?.[providerId] ?? {
        adapter: "pi-ai",
        upstreamProvider: providerId,
      };

      await store.updateOverlay(
        {
          providers: {
            [providerId]: {
              ...existing,
              credential: { kind: "seepient", id: providerId },
            },
          } as any,
        },
        snapshot.revision,
      );

      console.log(chalk.green(`✓ Successfully configured credential for provider account "${providerId}"`));
    });

  authCmd
    .command("logout <provider>")
    .description("Remove credentials for a provider account")
    .action(async (providerId) => {
      const store = new ProviderConfigStore();
      const snapshot = await store.getOverlay();
      const existing = (snapshot.patch?.providers as any)?.[providerId];
      if (!existing) {
        console.log(chalk.yellow(`Provider "${providerId}" is not configured.`));
        return;
      }

      const credStore = new CompositeCredentialStore();
      await credStore.delete(providerId);

      await store.updateOverlay(
        {
          providers: {
            [providerId]: {
              ...existing,
              credential: { kind: "none" },
            },
          } as any,
        },
        snapshot.revision,
      );

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
