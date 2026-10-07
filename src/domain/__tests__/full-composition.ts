/**
 * Spec 027 test helper — the full-package composition, registered into the
 * engine seams: built-in tool modules, built-in analyzers, and the
 * boundary-carrying pipeline. Domain tests that exercise built-in tools call
 * `registerFullComposition()` once at module load.
 */
import { builtInTools } from "../../capabilities/tools/index.js";
import { DEFAULT_ANALYZERS } from "../../capabilities/tools/analyzers.js";
import { COMM_ANALYZERS } from "../../capabilities/tools/comm-analyzers.js";
import { buildLocalBoundary } from "../../capabilities/execution/build-local-boundary.js";
import {
  registerDefaultToolModules,
  registerBuiltInAnalyzers,
  registerExecutionBoundaryFactory,
} from "../../foundations/injection-seams.js";

let registered = false;

export function registerFullComposition(): void {
  if (registered) return;
  registered = true;
  registerDefaultToolModules([...builtInTools]);
  registerBuiltInAnalyzers({ ...DEFAULT_ANALYZERS, ...COMM_ANALYZERS });
  registerExecutionBoundaryFactory(
    async (opts) => buildLocalBoundary(opts as Parameters<typeof buildLocalBoundary>[0]),
  );
}
