/**
 * Environment detection — pure process/TTY/container checks.
 * Foundations-grade: any layer may ask these questions; they answer about
 * the process, never about the product.
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
