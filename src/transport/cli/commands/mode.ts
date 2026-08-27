/**
 * Seepient CLI — /mode Command Handler (spec 017, T027).
 *
 * Shows the current consent mode and switches between:
 *   - ask-everything (manual)
 *   - edit-enabled (balanced, default)
 *   - autonomous (autonomous)
 */
import chalk from "chalk";
import type { CommandHandler } from "./registry.js";
import type { ConsentMode } from "../../../foundations/settings-schema.js";
import { createSettingsManager } from "./settings.js";

const VALID_MODES: ReadonlyArray<ConsentMode> = [
  "ask-everything",
  "edit-enabled",
  "autonomous",
];

const MODE_DESCRIPTIONS: Record<ConsentMode, string> = {
  "ask-everything": "Prompt for every effectful action within the ceiling",
  "edit-enabled": "Auto-approve edits, reads, and brokered fetches; prompt for destructive commands and sends (default)",
  autonomous: "Prompt-free execution; engine auto-issues in-ceiling capabilities",
};

export const modeHandler: CommandHandler = async (ctx) => {
  const args = ctx.args || "";
  const targetMode = args.trim().toLowerCase() as ConsentMode;

  if (!targetMode) {
    const currentMode = ctx.agent?.getConsentMode?.() ?? "edit-enabled";
    const lines = [
      chalk.bold.cyan("Consent Modes:"),
      "",
      ...VALID_MODES.map((mode) => {
        const isCurrent = mode === currentMode;
        const marker = isCurrent ? chalk.green("● (active)") : chalk.dim("○");
        const name = isCurrent ? chalk.bold.green(mode) : chalk.bold(mode);
        return `  ${marker} ${name.padEnd(20)} ${chalk.dim(MODE_DESCRIPTIONS[mode])}`;
      }),
      "",
      chalk.dim("Usage: /mode <ask-everything | edit-enabled | autonomous>"),
      chalk.dim("Shortcut: Shift+Tab cycles modes in TUI"),
    ];
    return { output: lines.join("\n") };
  }

  if (!VALID_MODES.includes(targetMode)) {
    return {
      output: chalk.red(
        `Invalid mode: "${targetMode}". Valid modes are: ${VALID_MODES.join(", ")}`,
      ),
    };
  }

  try {
    if (ctx.agent?.setConsentMode) {
      ctx.agent.setConsentMode(targetMode);
    }
    // Persist to workspace settings
    const settings = createSettingsManager();
    await settings.set("permissions.consentMode", targetMode);

    return {
      output: chalk.green(
        `Switched consent mode to: ${chalk.bold(targetMode)} (${MODE_DESCRIPTIONS[targetMode]})`,
      ),
    };
  } catch (err) {
    return {
      output: chalk.red(
        `Failed to switch consent mode: ${err instanceof Error ? err.message : String(err)}`,
      ),
    };
  }
};
