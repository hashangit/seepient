/**
 * Canonical security-store paths — Foundations (spec 008 T108a + review P0).
 *
 * The protected policy/audit stores live under a security root that may be
 * the default (`~/.seepient/security`) or an operator override
 * (`SEEPIENT_SECURITY_DIR`). EVERY enforcement surface must derive its
 * protected paths from THIS module — the process sandbox profile, the
 * structured read/commit executors, and the process executor — so a
 * configured override can never leave the default store exposed or vice
 * versa (review round 3 finding).
 *
 * The module is pure data; it does not spawn or enforce.
 */
import * as os from "node:os";
import * as path from "node:path";
import { realpathSync } from "node:fs";

/**
 * The security STORE roots: the directories that hold the protected policy,
 * audit, and grants data. Denying these (and their parents where
 * applicable) protects every store. Always includes the default
 * `~/.seepient` and the `SEEPIENT_SECURITY_DIR` override when set — an
 * override REPLACES the default store location but must not leave the
 * default writable either.
 */
export function securityStoreRoots(): string[] {
  const out: string[] = [path.join(os.homedir(), ".seepient")];
  const override = process.env.SEEPIENT_SECURITY_DIR;
  if (override) {
    out.push(path.resolve(override));
  }
  return out;
}

/**
 * The canonical security directories themselves (equal-or-descendant
 * matching target for `isSecurityPath`). Canonicalized with realpath when
 * the directory exists (macOS /var -> /private/var), resolved otherwise.
 */
export function securityDirectories(): string[] {
  const dirs: string[] = [];
  const override = process.env.SEEPIENT_SECURITY_DIR;
  if (override) {
    dirs.push(path.resolve(override));
  }
  dirs.push(path.join(os.homedir(), ".seepient", "security"));
  return dirs.map((p) => {
    try {
      return realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  });
}

/**
 * True when `p` is equal to or a descendant of any canonical security
 * directory. Applies to commit targets, read targets, and process cwd/root
 * values (T108a + review P0: the override must be protected too).
 */
export function isSecurityPath(p: string): boolean {
  const normalized = path.normalize(p);
  return securityDirectories().some(
    (d) => normalized === d || normalized.startsWith(d + path.sep),
  );
}
