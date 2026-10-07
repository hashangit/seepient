/**
 * Image-backend registration — Capabilities (spec 027 FR-009).
 *
 * Registers the direct-SDK image-raw vendors into the foundation seam. Lives
 * in Capabilities because src/vendors/ imports are forbidden from Transport
 * and UI (S-12); the full package's composition roots call this once at load.
 */
import { registerImageBackendFactories } from "../../foundations/injection-seams.js";
import { GoogleImageRaw } from "../../vendors/google/google-image-raw.js";
import { OpenAIImageRaw } from "../../vendors/openai/openai-image-raw.js";

export function registerImageBackends(): void {
  registerImageBackendFactories({
    google: () => new GoogleImageRaw(),
    openai: () => new OpenAIImageRaw(),
  });
}
