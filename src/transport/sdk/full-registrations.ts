/**
 * Full-package registrations (spec 027).
 *
 * The full `seepient` package registers its built-in tool barrel, boundary
 * pipeline, media/image vendors, provider discovery sources, and provider
 * management API into the engine's injection seams. Imported by every full
 * composition root (SDK entry, CLI, server) at module load — engine modules
 * hold no static or dynamic edge into this tree.
 */
import type { ToolModule } from "seepient-core/dist/foundations/contracts/tool.js";
import {
  registerBuiltInAnalyzers,
  registerDefaultToolModules,
  registerMediaVendorOperationHandlerFactory,
  registerExecutionBoundaryFactory,
  registerProviderManagerApiFactory,
  registerBrokerConnectorEvaluator,
  registerAmbientStoreDefaults,
} from "seepient-core/dist/foundations/injection-seams.js";
import { registerImageBackends } from "../../capabilities/inference/register-image-backends.js";
import { registerDiscoverySources } from "../../capabilities/inference/register-discovery-sources.js";
import { registerExactEstimator } from "../../capabilities/tokenizer/register-exact-estimator.js";
import { builtInTools } from "../../capabilities/tools/index.js";
import { DEFAULT_ANALYZERS } from "../../capabilities/tools/analyzers.js";
import { COMM_ANALYZERS } from "../../capabilities/tools/comm-analyzers.js";
import { UseSkillTool } from "seepient-core/dist/domain/skills/use-skill-tool.js";
import { createMediaVendorOperationHandler } from "../../domain/media/vendor-operation-handler.js";
import { buildLocalBoundary } from "../../capabilities/execution/build-local-boundary.js";

/**
 * The full package's built-in tool modules — the former core-side
 * `BUILT_IN_TOOL_MODULES`, now owned by the full package (FR-003).
 */
export const FULL_TOOL_MODULES: readonly ToolModule[] = Object.freeze([
  ...builtInTools,
  UseSkillTool,
]);

registerDefaultToolModules(FULL_TOOL_MODULES);

// Review P1-3: Profile A ambient defaults (~/.seepient) ride the full
// package only; seepient-core resolves every single-mode default to the
// in-memory store set (gate r1 P2-c: keyed on this registration, not on
// the stateless option).
registerAmbientStoreDefaults();

// Spec 027: built-in tool analyzers (prepared-action builders) register with
// the engine; the consent pipeline consults the seam table.
registerBuiltInAnalyzers({
  ...DEFAULT_ANALYZERS,
  ...COMM_ANALYZERS,
});

// Spec 027 FR-009: media/image vendors are full-package registrations.
registerMediaVendorOperationHandlerFactory(
  (opts) => createMediaVendorOperationHandler(opts as Parameters<typeof createMediaVendorOperationHandler>[0]),
);
registerImageBackends();
registerDiscoverySources();
registerExactEstimator();

// Spec 027 FR-012: the boundary-carrying pipeline (sandbox + effect broker +
// native helper) is a full-package injection; the engine default is light.
registerExecutionBoundaryFactory(
  async (opts) =>
    buildLocalBoundary(opts as Parameters<typeof buildLocalBoundary>[0]),
);

// Spec 027: broker-connector evaluation (MCP connector registry) is lazy
// full-package machinery behind the seam.
registerBrokerConnectorEvaluator(async (registration, args, ctx) => {
  const { evaluateBrokerConnector } = await import("../../capabilities/tools/connector-registry.js");
  return evaluateBrokerConnector(registration as never, args, ctx as never);
});

// Spec 027: provider management (CLI impl) arrives via a lazy registration.
registerProviderManagerApiFactory(async (runtime) => {
  const { createProviderManagerApi } = await import("../cli/provider-manager-api.js");
  return createProviderManagerApi(runtime as Parameters<typeof createProviderManagerApi>[0]);
});
