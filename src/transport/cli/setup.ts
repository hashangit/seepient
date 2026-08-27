/**
 * Seepient CLI — Setup Wizard Wrapper (013 T023/T024)
 *
 * Thin CLI entry for the setup wizard. Delegates interactive flow to
 * `runSetupWizard` (Ink TUI) and manages documents workspace scaffolding.
 */

import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { isNonInteractive } from '../../foundations/environment.js';

export function ensureDocumentsWorkspace(): void {
  const docsDir = path.join(os.homedir(), 'seepient_documents');
  const subdirs = ['notes', 'templates', 'output', 'knowledge'];
  if (!fs.existsSync(docsDir)) {
    fs.mkdirSync(docsDir, { recursive: true });
    for (const sub of subdirs) {
      fs.mkdirSync(path.join(docsDir, sub), { recursive: true });
    }
    fs.writeFileSync(
      path.join(docsDir, 'README.md'),
      `# seepient_documents\n\nThis is your Seepient agent workspace. Files here are accessible across all projects.\n\n- \`notes/\` — Agent-created notes and session logs\n- \`templates/\` — Reusable templates you or the agent can reference\n- \`output/\` — Generated artifacts (reports, summaries)\n- \`knowledge/\` — Reference documents for the agent to use\n\nReference files in conversation with \`@seepient_documents/path/to/file\`\n`,
      'utf-8'
    );
    console.log(chalk.green(`Created agent workspace at ${docsDir}`));
  }
}

export async function runSetup(options: { project?: boolean } = {}): Promise<void> {
  // Guard: setup wizard requires interactive TTY
  if (isNonInteractive()) {
    console.log(chalk.yellow('Setup wizard requires an interactive terminal.'));
    console.log(chalk.dim('Set API keys via environment variables instead:'));
    console.log(chalk.dim('  OPENAI_API_KEY, ANTHROPIC_API_KEY, GLM_API_KEY, OPENAI_COMPAT_API_KEY'));
    console.log(chalk.dim('  (or configure custom env vars via `seepient providers add <id> --credential env:VAR_NAME`)'));
    console.log(chalk.dim('Or configure model assignments headlessly:'));
    console.log(chalk.dim('  seepient models set text.standard <account>/<model>'));
    process.exit(1);
  }

  // readline's close() paused stdin; Ink 6 never resumes it — a paused TTY handle
  // does not keep the event loop alive, so the wizard would drain the loop and die.
  process.stdin.resume();

  const { runSetupWizard } = await import('../../ui/tui/setup-wizard.js');
  await runSetupWizard({ project: options.project });
  ensureDocumentsWorkspace();
}

