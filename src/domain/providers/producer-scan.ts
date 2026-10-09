/**
 * Producer enumeration by source scan (022-5-WO1 T024).
 *
 * The 022-5 FR-007 invariant list was a fixed file list — it cannot see a
 * NEW unarmed producer. This scan walks every non-test source file that
 * imports the vendored `@earendil-works/pi-ai` package and requires it to
 * carry the credential gate marker. Type-only imports are exempt.
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The marker the FR-007 gate carries at every armed producer. */
export const PRODUCER_GATE_MARKER = "022-5 FR-007";

/**
 * Files that import the vendored package but construct no inference client:
 * each exemption carries its reason. Anything NOT listed defaults to flagged
 * — a new producer must either carry the gate or justify its exemption here.
 */
export const EXEMPT_NON_PRODUCERS: Record<string, string> = {
  "src/vendors/pi-ai/index.ts": "wrapper barrel — re-exports the wrapper surface only, constructs no client",
  "src/vendors/pi-ai/pi-auth-adapter.ts": "OAuth flow bridge over the CredentialStore — no inference client",
  "src/vendors/pi-ai/pi-catalog-source.ts": "bundled static catalog — no keys, no network, no client",
  "src/vendors/pi-ai/pi-discovery-source.ts": "catalog-only discovery — no credentials involved",
  "src/vendors/pi-ai/pi-canonical-converter.ts": "pure message-type conversion — no client, no credentials",
  "src/domain/providers/producer-scan.ts": "this scan — matches its own literal by construction",
};

function stripCommentsAndTypeImports(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/import\s+type\s[^;]+;/g, "");
}

/** Source files importing the vendored package (non-test, non-type-only,
 *  actual import statements — comments do not count). */
export function vendoredImportSites(root = process.cwd()): string[] {
  // Single-quote the path: JSON.stringify does not escape shell metachars
  // ($, backticks survive inside double quotes). Strip single quotes from the
  // value itself so a hostile root cannot break out (gate r1 F-2 hardening;
  // no production caller passes attacker input today).
  const quoted = `'${join(root, "src").replace(/'/g, "'\\''")}'`;
  const out = execSync(`grep -rln "@earendil-works/pi-ai" ${quoted} --include='*.ts' | grep -v __tests__`, {
    encoding: "utf8",
  });
  return out
    .split("\n")
    .filter(Boolean)
    .filter((f) => {
      const src = stripCommentsAndTypeImports(readFileSync(f, "utf-8"));
      return src.includes("@earendil-works/pi-ai");
    });
}

/** The unarmed producers (root-relative paths): importing the vendored
 *  package without the gate. */
export function scanVendoredProducerSites(root = process.cwd()): string[] {
  const rootPrefix = join(root) + "/";
  return vendoredImportSites(root)
    .map((f) => (f.startsWith(rootPrefix) ? f.slice(rootPrefix.length) : f))
    .filter((f) => {
      if (EXEMPT_NON_PRODUCERS[f] !== undefined) return false;
      const src = readFileSync(join(root, f), "utf-8");
      return !src.includes(PRODUCER_GATE_MARKER);
    });
}
