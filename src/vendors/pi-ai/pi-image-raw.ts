import { builtinImagesModels } from "@earendil-works/pi-ai/providers/all";
import type {
  ImageBackend,
  InferenceTarget,
  InferenceOptions,
} from "../../foundations/contracts/backend-ports.js";
import type {
  ImageRequest,
  ImageResult,
} from "../../foundations/schemas/inference.js";
import { InferenceError } from "../../foundations/errors.js";

/**
 * Pi AI raw image backend implementation.
 */
export class PiImageRaw implements ImageBackend {
  private imageModels: any;

  constructor(customImageModels?: any) {
    this.imageModels = customImageModels ?? builtinImagesModels();
  }

  async generate(
    target: InferenceTarget,
    req: ImageRequest,
    opts?: InferenceOptions,
  ): Promise<ImageResult> {
    const lease = target.credential.acquireLease();

    try {
      if (opts?.signal?.aborted) {
        throw new InferenceError({
          code: "timeout",
          message: opts.signal.reason?.message || "Operation aborted",
          providerAccount: target.providerAccount,
          model: target.model,
          retryable: false,
        });
      }

      const secret = await lease.secret();
      const apiKey = secret.kind === "api_key" ? secret.value : undefined;

      const providerName = target.upstreamProvider;
      let model = this.imageModels.getModel(providerName, target.model);

      if (!model) {
        throw new InferenceError({
          code: "unsupported_capability",
          message: `Model "${target.model}" not found in Pi image catalog for provider "${target.upstreamProvider}"`,
          providerAccount: target.providerAccount,
          model: target.model,
          retryable: false,
        });
      }

      // Pi image generation
      try {
        const res: any = await this.imageModels.generateImage(model, {
          prompt: req.prompt,
          aspectRatio: req.aspectRatio,
          apiKey,
        });

        if (!res || !res.images || res.images.length === 0) {
          throw new InferenceError({
            code: "malformed_response",
            message: "Pi image backend produced 0 image items",
            providerAccount: target.providerAccount,
            model: target.model,
            retryable: false,
          });
        }

        const images = res.images.map((img: any) => ({
          mimeType: img.mimeType || "image/png",
          url: img.url,
          base64: img.base64 || img.data,
          revisedPrompt: img.revisedPrompt,
        }));

        return { images };
      } catch (err: any) {
        if (err instanceof InferenceError) throw err;
        throw new InferenceError({
          code: "network",
          message: err?.message || "Pi image generation failed",
          providerAccount: target.providerAccount,
          model: target.model,
          retryable: true,
          cause: err,
        });
      }
    } finally {
      await lease.release();
    }
  }
}
