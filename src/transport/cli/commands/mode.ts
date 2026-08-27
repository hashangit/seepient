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
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const targetMode = parts[0]?.toLowerCase() as ConsentMode;
  const confirmed = parts.includes('--confirm');

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

  const previousMode = ctx.agent?.getConsentMode?.() ?? "edit-enabled";

  try {
    const settings = createSettingsManager();

    if (targetMode === 'autonomous') {
      const isWarned = settings.get('permissions.autonomousWarned')?.value === true;
      if (!isWarned && !confirmed) {
        return {
          output: [
            chalk.bold.yellow('⚠ Autonomous Mode Warning'),
            'In autonomous mode, Seepient executes in-ceiling actions without prompting for approval.',
            'OS sandbox containment, network broker restrictions, and immutable denies remain active.',
            '',
            `To confirm and enable: ${chalk.bold('/mode autonomous --confirm')}`,
          ].join('\n'),
        };
      }
      if (!isWarned && confirmed) {
        await settings.set('permissions.autonomousWarned', 'true');
      }
    }

    if (ctx.agent?.setConsentMode) {
      ctx.agent.setConsentMode(targetMode);
    }
    // Persist to workspace settings
    await settings.set("permissions.consentMode", targetMode);

    return {
      output: chalk.green(
        `Switched consent mode to: ${chalk.bold(targetMode)} (${MODE_DESCRIPTIONS[targetMode]})`,
      ),
    };
  } catch (err) {
    if (ctx.agent?.setConsentMode) {
      ctx.agent.setConsentMode(previousMode);
    }
    return {
      output: chalk.red(
        `Failed to switch consent mode: ${err instanceof Error ? err.message : String(err)}`,
      ),
    };
  }
};
