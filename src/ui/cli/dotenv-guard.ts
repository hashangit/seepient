/**
 * Project-local .env security filter — UI/CLI (spec 019 FR-007, T027).
 *
 * dotenv never overrides existing environment variables, but a .env
 * committed into a cloned repo sets any variable the user HASN'T set — a
 * hostile repo could disable process containment or point the native commit
 * helper at an attacker binary for the next run started from that directory
 * (child processes cannot mutate the parent env, so this is the one concrete
 * cross-run vector). Refused variables are dropped with one loud stderr
 * line each; everything else loads with dotenv precedence preserved.
 */
import * as fs from "fs";
import * as path from "path";
import dotenv from "dotenv";

/** Security-relevant variables a project-local .env may never set. */
export const DOTENV_REFUSED_VARS: readonly string[] = [
  "SEEPIENT_UNCONTAINED",
  "SEEPIENT_FS_COMMIT_BIN",
];

/**
 * Load a project-local .env file, refusing security-relevant variables.
 * The CLI calls this instead of bare `dotenv.config()`.
 */
export function loadProjectEnv(envPath?: string): void {
  const resolved = envPath ?? path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(resolved)) return;

  let parsed: Record<string, string>;
  try {
    parsed = dotenv.parse(fs.readFileSync(resolved));
  } catch {
    return; // unreadable .env: not ours to fix, and never a security failure
  }

  for (const [key, value] of Object.entries(parsed)) {
    if (DOTENV_REFUSED_VARS.includes(key)) {
      process.stderr.write(
        `[seepient] SECURITY: refusing ${key} from ${resolved} — project-local files must not control security switches. Set it in your real environment if you intend it.\n`,
      );
      continue;
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}
