import type {
  InferenceTarget,
  InferenceOptions,
  LanguageRequest,
  BoundAdapter,
  BoundLanguageExecutor,
  BoundImageExecutor,
  LanguageBackend,
  ImageBackend,
  RawBackend,
} from "../../foundations/contracts/backend-ports.js";
import type {
  ImageRequest,
  ImageResult,
  UpstreamModel,
} from "../../foundations/schemas/inference.js";
import { InferenceError } from "../../foundations/errors.js";
import { PiLanguageRaw } from "../../vendors/pi-ai/pi-language-raw.js";
import { PiImageRaw } from "../../vendors/pi-ai/pi-image-raw.js";
import { GoogleImageRaw } from "../../vendors/google/google-image-raw.js";
import { OpenAIImageRaw } from "../../vendors/openai/openai-image-raw.js";
import { CURATED_MODELS } from "./catalog-merge.js";

export type ImageOperation = "generate" | "variation" | "edit" | "mask";

export type ImageBackendResolver = (
  target: InferenceTarget,
  op: ImageOperation,
  req: ImageRequest,
) => ImageBackend | undefined;

/**
 * Unified Aggregate Inference Adapter that composes peer vendor backends
 * and binds execution targets to capability-gated executors.
 */
export class AggregateInferenceAdapter {
  readonly id = "seepient-aggregate";

  private languageBackend: LanguageBackend;
  private piImageBackend: ImageBackend;
  private googleImageBackend: ImageBackend;
  private openaiImageBackend: ImageBackend;
  private catalog: readonly UpstreamModel[];

  constructor(
    customBackends?: {
      language?: LanguageBackend;
      piImage?: ImageBackend;
      googleImage?: ImageBackend;
      openaiImage?: ImageBackend;
    },
    catalog?: readonly UpstreamModel[],
  ) {
    this.languageBackend = customBackends?.language ?? new PiLanguageRaw();
    this.piImageBackend = customBackends?.piImage ?? new PiImageRaw();
    this.googleImageBackend = customBackends?.googleImage ?? new GoogleImageRaw();
    this.openaiImageBackend = customBackends?.openaiImage ?? new OpenAIImageRaw();
    this.catalog = catalog ?? CURATED_MODELS;
  }

  /**
   * Binds an InferenceTarget and returns capability-gated executors.
   */
  async bind(target: InferenceTarget): Promise<BoundAdapter> {
    const hasLang = this.hasLanguageCapability(target);
    const hasImg = this.hasImageCapability(target);

    return {
      target,
      language: hasLang ? this.bindLanguage(target) : undefined,
      images: hasImg ? this.bindImages(target) : undefined,
    };
  }

  private hasLanguageCapability(target: InferenceTarget): boolean {
    const model = this.catalog.find(
      (m) => m.id === target.model && m.upstreamProvider === target.upstreamProvider,
    );
    if (!model) return true; // optimistic default for dynamically discovered / custom models
    return model.capabilities.streaming || model.capabilities.toolUse;
  }

  private hasImageCapability(target: InferenceTarget): boolean {
    const model = this.catalog.find(
      (m) => m.id === target.model && m.upstreamProvider === target.upstreamProvider,
    );
    if (!model) {
      return (
        target.model.includes("dall-e") ||
        target.model.includes("image") ||
        target.model.includes("imagen")
      );
    }
    return !!(
      model.capabilities.imageGenerate ||
      model.capabilities.imageVariation ||
      model.capabilities.imageEdit ||
      model.capabilities.imageMask
    );
  }

  private bindLanguage(target: InferenceTarget): BoundLanguageExecutor {
    return {
      stream: (req: LanguageRequest, opts?: InferenceOptions) =>
        this.languageBackend.chatStream(target, req, opts),
      chat: (req: LanguageRequest, opts?: InferenceOptions) =>
        this.languageBackend.chat(target, req, opts),
    };
  }

  private bindImages(target: InferenceTarget): BoundImageExecutor {
    return {
      generate: async (req: ImageRequest, opts?: InferenceOptions): Promise<ImageResult> => {
        const op: ImageOperation = req.operation ?? "generate";
        const backend = this.resolveImageBackend(target, op, req);

        if (!backend) {
          throw new InferenceError({
            code: "unsupported_capability",
            message: `Model "${target.model}" under provider "${target.providerAccount}" does not support image operation "${op}".`,
            providerAccount: target.providerAccount,
            model: target.model,
            retryable: false,
          });
        }

        return backend.generate(target, req, opts);
      },
    };
  }

  /**
   * Resolves the appropriate ImageBackend for a specific (target, operation, request).
   */
  private resolveImageBackend(
    target: InferenceTarget,
    op: ImageOperation,
    req: ImageRequest,
  ): ImageBackend | undefined {
    if (target.upstreamProvider === "google") {
      return this.googleImageBackend;
    }

    if (target.upstreamProvider === "openai" || target.upstreamProvider === "openai-compatible") {
      return this.openaiImageBackend;
    }

    // Default to Pi image backend (e.g. OpenRouter or custom provider)
    return this.piImageBackend;
  }
}
