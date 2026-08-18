/**
 * Seepient CLI — `seepient models` and image generation commands
 *
 * Implements `models set`, `models list`, `models fallback`, `models check`,
 * `models probe`, `models status`, `models discover`, and `generate image`.
 */

import { Command } from "commander";
import chalk from "chalk";
import { ProviderConfigStore } from "../../../domain/providers/config-store/provider-config-store.js";
import { getDefaultProviderRuntime } from "../../../domain/providers/provider-runtime.js";
import { generateImagesStructured } from "../../../capabilities/media/media.js";

export function registerModelsCommands(program: Command): void {
  const modelsCmd = program.command("models").description("Manage purpose-based model assignments and status");

  modelsCmd
    .command("set <slot> <target>")
    .description("Assign a model to a purpose slot (e.g. text.standard openai/gpt-4o)")
    .option("--thinking <level>", "Reasoning/thinking level (none | minimal | low | medium | high | xhigh)")
    .action(async (slot, target, opts) => {
      const parts = slot.split(".");
      if (parts.length !== 2) {
        console.log(chalk.red(`Invalid slot format "${slot}". Expected format: <purpose>.<tier> (e.g. text.standard)`));
        process.exit(1);
      }
      const [purpose, tier] = parts;

      let providerAccount = "default";
      let model = target;
      if (target.includes("/")) {
        const tParts = target.split("/");
        providerAccount = tParts[0];
        model = tParts.slice(1).join("/");
      }

      const store = new ProviderConfigStore();
      const overlay = await store.getOverlay();

      const newAssignment = {
        providerAccount,
        model,
        ...(opts.thinking ? { thinkingLevel: opts.thinking } : {}),
      };

      await store.updateOverlay(
        {
          modelAssignments: {
            [purpose]: {
              [tier]: newAssignment,
            },
          } as any,
        },
        overlay.revision,
      );

      console.log(chalk.green(`✓ Set assignment ${slot} → ${providerAccount}/${model}${opts.thinking ? ` (thinking: ${opts.thinking})` : ""}`));
      console.log(chalk.dim("  Applies next turn."));
    });

  modelsCmd
    .command("list")
    .description("List model assignments and catalog")
    .option("--resolved", "Show effective resolved model assignments")
    .action(async (_opts) => {
      const store = new ProviderConfigStore();
      const config = await store.getEffectiveConfig();
      const assignments = config.modelAssignments || {};

      console.log(chalk.bold.cyan("\nEffective Model Assignments:"));
      for (const [purpose, tiers] of Object.entries(assignments)) {
        console.log(`\n  ${chalk.bold(purpose)}:`);
        for (const [tier, assign] of Object.entries(tiers as any)) {
          if (!assign) continue;
          const a = assign as any;
          const fb = a.fallback?.length ? chalk.dim(` [fallback: ${a.fallback.map((f: any) => `${f.providerAccount}/${f.model}`).join(", ")}]`) : "";
          const th = a.thinkingLevel ? chalk.magenta(` (thinking: ${a.thinkingLevel})`) : "";
          console.log(`    ${tier.padEnd(12)} → ${chalk.green(`${a.providerAccount}/${a.model}`)}${th}${fb}`);
        }
      }
      console.log("");
    });

  modelsCmd
    .command("fallback <slot> <targets>")
    .description("Configure ordered fallback models for a slot (e.g. text.standard openai/gpt-4o-mini,anthropic/haiku)")
    .action(async (slot, targets) => {
      const parts = slot.split(".");
      if (parts.length !== 2) {
        console.log(chalk.red(`Invalid slot format "${slot}". Expected format: <purpose>.<tier>`));
        process.exit(1);
      }
      const [purpose, tier] = parts;

      const fallbackList = targets.split(",").map((t: string) => {
        const trimmed = t.trim();
        if (trimmed.includes("/")) {
          const [acc, m] = trimmed.split("/");
          return { providerAccount: acc, model: m };
        }
        return { providerAccount: "default", model: trimmed };
      });

      const store = new ProviderConfigStore();
      const config = await store.getEffectiveConfig();
      const overlay = await store.getOverlay();
      const existing = (config.modelAssignments as any)?.[purpose]?.[tier] ?? { providerAccount: "default", model: "gpt-4o" };

      await store.updateOverlay(
        {
          modelAssignments: {
            [purpose]: {
              [tier]: {
                ...existing,
                fallback: fallbackList,
              },
            },
          } as any,
        },
        overlay.revision,
      );

      console.log(chalk.green(`✓ Configured ${fallbackList.length} fallback targets for ${slot}`));
      console.log(chalk.dim("  Applies next turn."));
    });

  modelsCmd
    .command("status")
    .description("Display active model assignments, serving models, and credential health")
    .action(async () => {
      const runtime = getDefaultProviderRuntime();
      const snapshot = await runtime.createTurnSnapshot();
      const assignments = snapshot.assignments;

      console.log(chalk.bold.cyan("\nProvider & Model Status (Current Turn):"));
      for (const [purpose, tiers] of Object.entries(assignments)) {
        for (const [tier, assign] of Object.entries(tiers as any)) {
          if (!assign) continue;
          const a = assign as any;
          const acc = snapshot.config?.providers?.[a.providerAccount];
          const credStatus = acc?.credential?.kind !== "none" ? chalk.green("OK") : chalk.yellow("MISSING_CREDENTIAL");

          console.log(`  ${chalk.bold(`${purpose}.${tier}`.padEnd(20))} : ${a.providerAccount}/${a.model} [${credStatus}]`);
        }
      }
      console.log(chalk.dim("\n  Note: Any pending changes take effect on the next turn boundary."));
      console.log("");
    });

  modelsCmd
    .command("check")
    .description("Pre-flight capability validation and assignment sanity check")
    .option("--offline", "Run checks without performing network calls")
    .option("--require <slots>", "Comma-separated list of required slots (e.g. text.standard,vision.standard)")
    .action(async (opts) => {
      const store = new ProviderConfigStore();
      const config = await store.getEffectiveConfig();
      const required = opts.require ? opts.require.split(",").map((s: string) => s.trim()) : ["text.standard"];

      let allPassed = true;
      for (const slot of required) {
        const [purpose, tier] = slot.split(".");
        const assign = (config.modelAssignments as any)?.[purpose]?.[tier];
        if (!assign) {
          console.log(chalk.red(`✗ Required slot "${slot}" is unconfigured.`));
          allPassed = false;
        } else {
          console.log(chalk.green(`✓ Required slot "${slot}" configured (${assign.providerAccount}/${assign.model})`));
        }
      }

      if (!allPassed) {
        process.exit(1);
      }
    });

  modelsCmd
    .command("probe <provider>")
    .description("Probe provider connectivity and credentials")
    .option("--full", "Perform minimal paid inference probe call", false)
    .action(async (providerId, opts) => {
      const runtime = getDefaultProviderRuntime();
      const snapshot = await runtime.createTurnSnapshot();
      const acc = snapshot.config?.providers?.[providerId];

      if (!acc) {
        console.log(chalk.red(`Error: Provider "${providerId}" not found.`));
        process.exit(1);
      }

      console.log(chalk.cyan(`Probing provider "${providerId}" (mode: ${opts.full ? "full" : "shallow"})...`));
      let authOk = false;
      try {
        const handle = await runtime.credentialStore.resolve(acc.credential);
        authOk = await handle.isResolvable();
      } catch {
        authOk = false;
      }

      if (authOk) {
        console.log(chalk.green(`✓ Provider "${providerId}" credential resolved successfully.`));
      } else {
        console.log(chalk.yellow(`⚠ Provider "${providerId}" has missing or unresolvable credential.`));
      }
    });

  modelsCmd
    .command("discover <account>")
    .description("Trigger shallow model discovery for a provider account")
    .action(async (accountId) => {
      console.log(chalk.cyan(`Refreshing model list for provider account "${accountId}"...`));
      const runtime = getDefaultProviderRuntime();
      try {
        const modelIds = await runtime.refreshModels(accountId);
        console.log(chalk.green(`✓ Successfully discovered ${modelIds.length} model(s) for "${accountId}".`));
        for (const id of modelIds) {
          console.log(`  - ${id}`);
        }
      } catch (e: any) {
        console.log(chalk.red(`Error discovering models for "${accountId}": ${e.message}`));
      }
    });

  // ── seepient generate image command ──────────────────────────────────────
  const genCmd = program.command("generate").description("Direct media generation commands");

  genCmd
    .command("image")
    .description("Generate or edit images via configured image provider")
    .option("--prompt <prompt>", "Text prompt for image generation")
    .option("--operation <op>", "Operation: generate | variation | edit | mask", "generate")
    .option("--aspect-ratio <ratio>", "Aspect ratio: 1:1, 16:9, 9:16", "1:1")
    .option("--quality-preset <quality>", "Quality preset: low | standard | high", "standard")
    .option("--count <n>", "Number of images to generate", "1")
    .option("--image <path>", "Input image path for variation or edit")
    .option("--mask <path>", "Input mask path for editing")
    .option("--output <dir>", "Output directory for generated images", ".")
    .action(async (opts) => {
      const runtime = getDefaultProviderRuntime();
      const res = await generateImagesStructured(
        {
          prompt: opts.prompt,
          mode: opts.operation === "variation" ? "variation" : opts.operation === "edit" ? "edit" : "text-to-image",
          size: opts.aspectRatio === "16:9" ? "1792x1024" : opts.aspectRatio === "9:16" ? "1024x1792" : "1024x1024",
          quality: opts.qualityPreset === "high" ? "hd" : "standard",
          n: parseInt(opts.count, 10) || 1,
          imagePath: opts.image,
          maskPath: opts.mask,
          outputDir: opts.output,
        },
        {
          runtime,
        },
      );

      if (!res.success) {
        console.log(chalk.red(res.error ?? "Failed to generate image."));
        process.exit(1);
      }

      console.log(chalk.bold.green(`✓ Generated ${res.files.length} image(s):`));
      for (const f of res.files) {
        console.log(`  - ${f}`);
      }
    });
}
