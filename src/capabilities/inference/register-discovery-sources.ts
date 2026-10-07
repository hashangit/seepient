/**
 * Discovery-source registration — Capabilities (spec 027).
 *
 * Registers the direct-SDK discovery-source loaders into the foundation seam.
 * Lives in Capabilities because src/vendors/ imports are forbidden from
 * Transport and UI (S-12); the full package's composition roots call this
 * once at load.
 */
import { registerDiscoverySourceLoaders } from "seepient-core/dist/foundations/injection-seams.js";

export function registerDiscoverySources(): void {
  registerDiscoverySourceLoaders({
    openai: async () => import("../../vendors/openai/openai-discovery-source.js"),
    google: async () => import("../../vendors/google/google-discovery-source.js"),
  });
}
