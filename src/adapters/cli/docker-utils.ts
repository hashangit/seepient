/**
 * Seepient CLI — Docker & Non-Interactive Detection
 *
 * Utilities for detecting Docker environments and non-interactive TTY contexts.
 * Used to guard inquirer prompts and readline settings.
 */

import * as fs from 'fs';

/**
 * Detect if the current process is running inside a Docker container.
 * Checks:
 *   1. /.dockerenv file existence
 *   2. /proc/1/cgroup contains "docker" or "containerd"
 *   3. SEEPIENT_DOCKER env var is "true"
 */
export function isDockerContainer(): boolean {
  // Explicit env var override (used by --docker flag too)
  if (process.env.SEEPIENT_DOCKER === 'true') return true;

  try {
    if (fs.existsSync('/.dockerenv')) return true;
  } catch {
    // Filesystem access may fail in restricted environments
  }

  try {
    const cgroup = fs.readFileSync('/proc/1/cgroup', 'utf-8');
    if (cgroup.includes('docker') || cgroup.includes('containerd')) return true;
  } catch {
    // /proc may not exist on non-Linux systems
  }

  return false;
}

/**
 * Determine if the CLI is running in a non-interactive context.
 * Returns true if:
 *   - stdin is not a TTY
 *   - --no-interactive flag was passed (SEEPIENT_NO_INTERACTIVE=true)
 *   - Running inside Docker (unless SEEPIENT_INTERACTIVE=true overrides it)
 */
export function isNonInteractive(): boolean {
  // Explicit opt-in to interactive mode overrides everything
  if (process.env.SEEPIENT_INTERACTIVE === 'true') return false;

  // Explicit non-interactive flag
  if (process.env.SEEPIENT_NO_INTERACTIVE === 'true') return true;

  // No TTY detected
  if (!process.stdin.isTTY) return true;

  // Running in Docker without explicit interactive override
  if (isDockerContainer()) return true;

  return false;
}

/**
 * Check if all required provider API keys are available via environment variables
 * or the provided config. If so, the setup wizard can be safely skipped.
 *
 * Environment variable mappings:
 *   - openai: OPENAI_API_KEY
 *   - openai-compatible: OPENAI_COMPAT_API_KEY
 *   - anthropic: ANTHROPIC_API_KEY
 *   - glm: GLM_API_KEY
 *
 * Also checks LLM_PROVIDER to know which one is needed.
 */
export function hasRequiredProviderEnv(config: { models?: Record<string, any> }): boolean {
  const provider = process.env.LLM_PROVIDER || config.models && Object.keys(config.models).find(
    k => (config.models as any)[k]?.apiKey
  );

  if (!provider) {
    return !!(
      process.env.OPENAI_API_KEY ||
      process.env.OPENAI_COMPAT_API_KEY ||
      process.env.ANTHROPIC_API_KEY ||
      process.env.GLM_API_KEY
    );
  }

  switch (provider) {
    case 'openai':
      return !!(process.env.OPENAI_API_KEY || config.models?.[provider]?.apiKey);
    case 'openai-compatible':
      return !!(process.env.OPENAI_COMPAT_API_KEY || config.models?.[provider]?.apiKey);
    case 'anthropic':
      return !!(process.env.ANTHROPIC_API_KEY || config.models?.[provider]?.apiKey);
    case 'glm':
      return !!(process.env.GLM_API_KEY || config.models?.[provider]?.apiKey);
    default:
      return !!(config.models?.[provider]?.apiKey);
  }
}
