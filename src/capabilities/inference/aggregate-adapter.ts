import type {
  InferenceTarget,
  InferenceOptions,
  LanguageRequest,
  BoundAdapter,
  BoundLanguageExecutor,
  BoundImageExecutor,
  LanguageBackend,
  ImageBackend,
  ImageOperation,
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
   * Updates the runtime model catalog for dynamic/user-declared model routing.
   */
  updateCatalog(catalog: readonly UpstreamModel[]): void {
    this.catalog = catalog;
  }

  /**
   * Binds an InferenceTarget and returns capability-gated executors.
   * Can evaluate against a snapshot-pinned catalog or the adapter's runtime catalog.
   */
  async bind(
    target: InferenceTarget,
    catalog?: readonly UpstreamModel[],
  ): Promise<BoundAdapter> {
    const hasLang = this.hasLanguageCapability(target, catalog);
    const hasImg = this.hasImageCapability(target, catalog);

    return {
      target,
      language: hasLang ? this.bindLanguage(target) : undefined,
      images: hasImg ? this.bindImages(target, catalog) : undefined,
    };
  }

  private findCatalogModel(
    target: InferenceTarget,
    catalog?: readonly UpstreamModel[],
  ): UpstreamModel | undefined {
    const effectiveCatalog = catalog ?? this.catalog;
    return effectiveCatalog.find(
      (m) => m.id === target.model && m.upstreamProvider === target.upstreamProvider,
    );
  }

  private hasLanguageCapability(
    target: InferenceTarget,
    catalog?: readonly UpstreamModel[],
  ): boolean {
    const model = this.findCatalogModel(target, catalog);
    if (!model) return true; // optimistic default for dynamic/custom language models
    return !!(model.capabilities.streaming || model.capabilities.toolUse);
  }

  private hasImageCapability(
    target: InferenceTarget,
    catalog?: readonly UpstreamModel[],
  ): boolean {
    const model = this.findCatalogModel(target, catalog);
    if (!model) return false;
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

  private bindImages(
    target: InferenceTarget,
    catalog?: readonly UpstreamModel[],
  ): BoundImageExecutor {
    return {
      generate: async (req: ImageRequest, opts?: InferenceOptions): Promise<ImageResult> => {
        const op: ImageOperation = req.operation ?? "generate";
        const backend = this.resolveImageBackend(target, op, req, catalog);

        if (!backend) {
          throw new InferenceError({
            code: "unsupported_capability",
            message: `Model "${target.model}" under provider "${target.upstreamProvider}" does not support image operation "${op}".`,
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
   * Strictly verifies catalog capability flags and never silently falls back to an unrelated provider.
   */
  private resolveImageBackend(
    target: InferenceTarget,
    op: ImageOperation,
    req: ImageRequest,
    catalog?: readonly UpstreamModel[],
  ): ImageBackend | undefined {
    const model = this.findCatalogModel(target, catalog);
    if (!model) return undefined;

    // Verify operation support on the specific catalog model
    let opSupported = false;
    if (op === "generate" && model.capabilities.imageGenerate) opSupported = true;
    else if (op === "variation" && model.capabilities.imageVariation) opSupported = true;
    else if (op === "edit" && model.capabilities.imageEdit) opSupported = true;
    else if (op === "mask" && model.capabilities.imageMask) opSupported = true;

    if (!opSupported) return undefined;

    if (target.upstreamProvider === "google") {
      return this.googleImageBackend;
    }
    if (target.upstreamProvider === "openai") {
      return this.openaiImageBackend;
    }
    return this.piImageBackend;
  }
}
