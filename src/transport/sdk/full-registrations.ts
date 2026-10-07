/**
 * Full-package registrations (spec 027).
 *
 * The full `seepient` package registers its built-in tool barrel, boundary
 * pipeline, media/image vendors, provider discovery sources, and provider
 * management API into the engine's injection seams. Imported by every full
 * composition root (SDK entry, CLI, server) at module load — engine modules
 * hold no static or dynamic edge into this tree.
 */
import type { ToolModule } from "../../foundations/contracts/tool.js";
import {
  registerDefaultToolModules,
  registerMediaVendorOperationHandlerFactory,
  registerExecutionBoundaryFactory,
  registerProviderManagerApiFactory,
} from "../../foundations/injection-seams.js";
import { registerImageBackends } from "../../capabilities/inference/register-image-backends.js";
import { builtInTools } from "../../capabilities/tools/index.js";
import { UseSkillTool } from "../../domain/skills/use-skill-tool.js";
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

// Spec 027 FR-009: media/image vendors are full-package registrations.
registerMediaVendorOperationHandlerFactory(
  (opts) => createMediaVendorOperationHandler(opts as Parameters<typeof createMediaVendorOperationHandler>[0]),
);
registerImageBackends();

// Spec 027 FR-012: the boundary-carrying pipeline (sandbox + effect broker +
// native helper) is a full-package injection; the engine default is light.
registerExecutionBoundaryFactory(
  async (opts) =>
    buildLocalBoundary(opts as Parameters<typeof buildLocalBoundary>[0]),
);

// Spec 027: provider management (CLI impl) arrives via a lazy registration.
registerProviderManagerApiFactory(async (runtime) => {
  const { createProviderManagerApi } = await import("../cli/provider-manager-api.js");
  return createProviderManagerApi(runtime as Parameters<typeof createProviderManagerApi>[0]);
});
