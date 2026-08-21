/**
 * Seepient CLI — `seepient models` and image generation commands
 *
 * Implements `models browse`, `models resolve`, `models set`, `models list`,
 * `models fallback`, `models check`, `models probe`, `models status`, `models discover`,
 * and `generate image`. Refactored onto ProviderManagerApi controller (013 US8 / R15).
 */

import { Command } from "commander";
import chalk from "chalk";
import { getDefaultProviderRuntime } from "../../../domain/providers/provider-runtime.js";
import { createProviderManagerApi, type PurposeId, type Tier } from "../provider-manager-api.js";
import { generateImagesStructured } from "../../../capabilities/media/media.js";

export function registerModelsCommands(program: Command): void {
  const modelsCmd = program.command("models").description("Manage purpose-based model assignments, browse catalog, and resolve status");

  modelsCmd
    .command("browse [query]")
    .description("Browse available models in the catalog with reachability badges")
    .option("--json", "Output JSON array of models")
    .option("--reachable-only", "Show only models reachable with current credentials")
    .action(async (query, opts) => {
      const runtime = getDefaultProviderRuntime();
      const api = createProviderManagerApi(runtime);
      const state = await api.getState();

      const q = typeof query === "string" ? query.trim().toLowerCase() : "";
      let list = state.models;

      if (q) {
        list = list.filter(
          (m) =>
            m.id.toLowerCase().includes(q) ||
            m.displayName.toLowerCase().includes(q) ||
            m.upstreamProvider.toLowerCase().includes(q),
        );
      }

      if (opts.reachableOnly) {
        list = list.filter((m) => m.reachableVia.length > 0);
      }

      if (opts.json) {
        console.log(JSON.stringify(list, null, 2));
        return;
      }

      if (list.length === 0) {
        console.log(chalk.yellow(q ? `No models found matching "${query}".` : "No models available in catalog."));
        return;
      }

      console.log(chalk.bold.cyan(`\nAvailable Models in Catalog (${list.length}):\n`));

      for (const m of list) {
        const reachBadge = m.reachableVia.length > 0
          ? chalk.green(`● reachable (${m.reachableVia.join(", ")})`)
          : chalk.yellow("○ unconfigured");

        const ctxStr = m.contextWindow ? `${Math.round(m.contextWindow / 1000)}k ctx` : "";
        const priceStr = m.pricing
          ? `$${((m.pricing.promptPerMillion ?? 0)).toFixed(2)}/M in · $${((m.pricing.completionPerMillion ?? 0)).toFixed(2)}/M out`
          : "price unknown";

        const caps = [
          m.capabilities.toolUse !== false ? "tools" : "",
          m.capabilities.streaming !== false ? "stream" : "",
          m.capabilities.vision ? "vision" : "",
          m.supportedReasoningLevels && m.supportedReasoningLevels.some((l) => l !== "none") ? "reasoning" : "",
        ]
          .filter(Boolean)
          .join(", ");

        console.log(`  ${chalk.bold(m.id)} ${chalk.dim(`(${m.upstreamProvider})`)}  ${reachBadge}`);
        console.log(`    ${chalk.dim(m.displayName)}`);
        console.log(`    ${chalk.dim([ctxStr, priceStr, caps ? `[${caps}]` : ""].filter(Boolean).join(" · "))}`);
      }
      console.log("");
    });

  modelsCmd
    .command("resolve <slot>")
    .description("Dry-run resolve a purpose slot (e.g. text.standard, coding.complex, media.image)")
    .option("--json", "Output resolution result as JSON")
    .action(async (slot, opts) => {
      const runtime = getDefaultProviderRuntime();
      const api = createProviderManagerApi(runtime);

      let purpose: string;
      let tier: string | undefined = undefined;
      if (slot.startsWith("media.")) {
        purpose = slot;
        tier = undefined;
      } else if (slot.includes(".")) {
        const parts = slot.split(".");
        purpose = parts[0];
        tier = parts[1];
      } else {
        purpose = slot;
      }

      const res = await api.resolvePreview(purpose as PurposeId, tier as Tier | undefined);

      if (opts.json) {
        console.log(JSON.stringify(res, null, 2));
        if ("ok" in res && (res as any).ok === false) {
          process.exitCode = 1;
        }
        return;
      }

      if ("ok" in res && (res as any).ok === false) {
        console.error(chalk.red(`Error (${(res as any).code}): ${(res as any).message}`));
        process.exitCode = 1;
        return;
      }

      const preview = res as any;
      console.log(chalk.bold.cyan(`\nResolution Preview for "${slot}":`));
      if (preview.selectedTarget) {
        console.log(`  Selected: ${chalk.green.bold(`${preview.selectedTarget.providerAccount}/${preview.selectedTarget.model}`)}`);
        console.log(`  Via:      ${chalk.dim(preview.via === "requested" ? "explicit assignment" : `fallback chain (${preview.via})`)}`);
      } else {
        console.log(`  Selected: ${chalk.yellow("unassigned / unstaffed")}`);
      }

      if (preview.failureTargets && preview.failureTargets.length > 0) {
        console.log(chalk.yellow(`  Unresolvable targets:`));
        for (const f of preview.failureTargets) {
          const reasonStr = f.reason ? `: ${f.reason}` : "";
          console.log(`    - ${f.providerAccount}/${f.model}${reasonStr}`);
        }
      }
      console.log("");
    });

  modelsCmd
    .command("set <slot> <target>")
    .description("Assign a model to a purpose slot (e.g. text.standard openai/gpt-4o)")
    .option("--thinking <level>", "Reasoning/thinking level (none | minimal | low | medium | high | xhigh)")
    .action(async (slot, target, opts) => {
      const runtime = getDefaultProviderRuntime();
      const api = createProviderManagerApi(runtime);

      let purpose: string;
      let tier: string | null = null;
      if (slot.startsWith("media.")) {
        purpose = slot;
        tier = null;
      } else if (slot.includes(".")) {
        const parts = slot.split(".");
        purpose = parts[0];
        tier = parts[1];
      } else {
        purpose = slot;
      }

      let providerAccount = "default";
      let model = target;
      if (target.includes("/")) {
        const tParts = target.split("/");
        providerAccount = tParts[0];
        model = tParts.slice(1).join("/");
      }

      const res = await api.setAssignment(purpose as PurposeId, tier as Tier | null, {
        providerAccount,
        model,
        ...(opts.thinking ? { thinkingLevel: opts.thinking } : {}),
      });

      if (!res.ok) {
        console.error(chalk.red(`Error (${res.error.code}): ${res.error.message}`));
        process.exit(1);
      }

      console.log(chalk.green(`✓ Set assignment ${slot} → ${providerAccount}/${model}${opts.thinking ? ` (thinking: ${opts.thinking})` : ""}`));
      console.log(chalk.dim("  Applies next turn."));
    });

  modelsCmd
    .command("list")
    .description("List model assignments and catalog")
    .option("--resolved", "Show effective resolved model assignments")
    .action(async (opts) => {
      const runtime = getDefaultProviderRuntime();
      const api = createProviderManagerApi(runtime);
      const state = await api.getState();

      console.log(chalk.bold.cyan("\nModel Assignments:"));
      for (const p of state.purposes) {
        console.log(`\n  ${chalk.bold(p.label)} (${p.id}):`);
        if (p.tiered) {
          for (const t of ["standard", "efficient", "complex"] as const) {
            const assign = (state.assignments as any)?.[p.id]?.[t];
            if (assign) {
              const th = assign.thinkingLevel ? chalk.magenta(` (thinking: ${assign.thinkingLevel})`) : "";
              console.log(`    ${t.padEnd(12)} → ${chalk.green(`${assign.providerAccount}/${assign.model}`)}${th}`);
            } else if (opts.resolved) {
              const preview: any = await api.resolvePreview(p.id, t);
              if (preview?.selectedTarget) {
                console.log(`    ${t.padEnd(12)} → ${chalk.dim(`${preview.selectedTarget.providerAccount}/${preview.selectedTarget.model} (via ${preview.via})`)}`);
              } else {
                console.log(`    ${t.padEnd(12)} → ${chalk.yellow("unassigned")}`);
              }
            } else {
              console.log(`    ${t.padEnd(12)} → ${chalk.yellow("unassigned")}`);
            }
          }
        } else {
          const sub = p.id.startsWith("media.") ? p.id.slice("media.".length) : p.id;
          const assign = (state.assignments as any)?.[p.id] ?? (state.assignments as any)?.media?.[sub];
          if (assign) {
            console.log(`    ${"single".padEnd(12)} → ${chalk.green(`${assign.providerAccount}/${assign.model}`)}`);
          } else if (opts.resolved) {
            const preview: any = await api.resolvePreview(p.id, undefined);
            if (preview?.selectedTarget) {
              console.log(`    ${"single".padEnd(12)} → ${chalk.dim(`${preview.selectedTarget.providerAccount}/${preview.selectedTarget.model} (via ${preview.via})`)}`);
            } else {
              console.log(`    ${"single".padEnd(12)} → ${chalk.yellow("unassigned")}`);
            }
          } else {
            console.log(`    ${"single".padEnd(12)} → ${chalk.yellow("unassigned")}`);
          }
        }
      }
      console.log("");
    });

  modelsCmd
    .command("fallback <slot> <targets>")
    .description("Configure ordered fallback models for a slot (e.g. text.standard openai/gpt-4o-mini,anthropic/haiku)")
    .action(async (slot, targets) => {
      let purpose: string;
      let tier: string | null = null;
      if (slot.startsWith("media.")) {
        purpose = slot;
        tier = null;
      } else if (slot.includes(".")) {
        const parts = slot.split(".");
        purpose = parts[0];
        tier = parts[1];
      } else {
        console.error(chalk.red(`Invalid slot format "${slot}". Expected format: <purpose>.<tier> or <media.purpose>`));
        process.exit(1);
      }

      const fallbackList = targets.split(",").map((t: string) => {
        const trimmed = t.trim();
        if (trimmed.includes("/")) {
          const [acc, m] = trimmed.split("/");
          return { providerAccount: acc, model: m };
        }
        return { providerAccount: "default", model: trimmed };
      });

      const runtime = getDefaultProviderRuntime();
      const api = createProviderManagerApi(runtime);
      const state = await api.getState();
      const sub = purpose.startsWith("media.") ? purpose.slice("media.".length) : purpose;
      const existing = tier ? (state.assignments as any)?.[purpose]?.[tier] : ((state.assignments as any)?.[purpose] ?? (state.assignments as any)?.media?.[sub]);

      if (!existing) {
        console.error(chalk.red(`Error: Cannot set fallbacks on unassigned slot "${slot}". Assign a primary model first with seepient models set ${slot} <target>.`));
        process.exit(1);
      }

      const res = await api.setAssignment(purpose as PurposeId, tier as Tier | null, {
        ...existing,
        fallback: fallbackList,
      });

      if (!res.ok) {
        console.error(chalk.red(`Error (${res.error.code}): ${res.error.message}`));
        process.exit(1);
      }

      console.log(chalk.green(`✓ Configured ${fallbackList.length} fallback targets for ${slot}`));
      console.log(chalk.dim("  Applies next turn."));
    });

  modelsCmd
    .command("status")
    .description("Display active model assignments, serving models, and credential health")
    .action(async () => {
      const runtime = getDefaultProviderRuntime();
      const api = createProviderManagerApi(runtime);
      const state = await api.getState();

      console.log(chalk.bold.cyan("\nProvider & Model Status (Current Config):"));
      for (const p of state.purposes) {
        if (p.tiered) {
          for (const t of ["standard", "efficient", "complex"] as const) {
            const assign = (state.assignments as any)?.[p.id]?.[t];
            if (!assign) continue;
            const acc = state.accounts.find((a) => a.id === assign.providerAccount);
            const credStatus = acc?.health === "ok"
              ? chalk.green("OK")
              : acc?.health === "expired"
              ? chalk.red("EXPIRED")
              : acc?.health === "missing"
              ? chalk.red("MISSING_CREDENTIAL")
              : chalk.yellow("UNVERIFIED");

            console.log(`  ${chalk.bold(`${p.id}.${t}`.padEnd(20))} : ${assign.providerAccount}/${assign.model} [${credStatus}]`);
          }
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
      const runtime = getDefaultProviderRuntime();
      const api = createProviderManagerApi(runtime);
      const state = await api.getState();
      const required = opts.require ? opts.require.split(",").map((s: string) => s.trim()) : ["text.standard"];

      let allPassed = true;
      for (const slot of required) {
        const [purpose, tier] = slot.split(".");
        const assign = (state.assignments as any)?.[purpose]?.[tier];
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
    .action(async (providerId) => {
      const runtime = getDefaultProviderRuntime();
      const api = createProviderManagerApi(runtime);

      console.log(chalk.cyan(`Probing provider account "${providerId}"...`));
      const res = await api.probeAccount(providerId);

      if (res.authValid) {
        console.log(chalk.green(`✓ Provider "${providerId}" credential verified successfully.${res.reachable === false ? " (endpoint unreachable)" : ""}`));
      } else {
        console.log(chalk.yellow(`⚠ Provider "${providerId}" authentication failed or credential missing.`));
      }
    });

  modelsCmd
    .command("discover <account>")
    .description("Trigger model discovery for a provider account")
    .action(async (accountId) => {
      console.log(chalk.cyan(`Refreshing model list for provider account "${accountId}"...`));
      const runtime = getDefaultProviderRuntime();
      const api = createProviderManagerApi(runtime);
      const res = await api.refreshModels(accountId);

      if (res.ok && res.discovered) {
        console.log(chalk.green(`✓ Successfully discovered ${res.discovered.length} model(s) for "${accountId}".`));
        for (const id of res.discovered) {
          console.log(`  - ${id}`);
        }
      } else {
        console.log(chalk.red(`Error discovering models for "${accountId}": ${res.error?.message ?? "unknown error"}`));
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
