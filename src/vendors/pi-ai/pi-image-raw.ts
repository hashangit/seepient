import { builtinImagesModels } from "@earendil-works/pi-ai/providers/all";
import type {
  ImagesModel,
  ImagesApi,
  ImagesInputContent,
  AssistantImages,
} from "@earendil-works/pi-ai";
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
import { classifyInferenceError } from "../../foundations/errors/error-classifier.js";

/** Combine AbortSignal and timeoutMs into a single effective AbortSignal */
function resolveSignal(opts?: InferenceOptions): {
  signal?: AbortSignal;
  cleanup: () => void;
  isTimeout: () => boolean;
} {
  if (!opts?.timeoutMs && !opts?.signal) {
    return { signal: undefined, cleanup: () => {}, isTimeout: () => false };
  }

  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;

  if (opts.timeoutMs && opts.timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(`Operation timed out after ${opts.timeoutMs}ms`));
    }, opts.timeoutMs);
  }

  const onAbort = () => controller.abort(opts.signal?.reason);
  if (opts.signal) {
    if (opts.signal.aborted) {
      controller.abort(opts.signal.reason);
    } else {
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      if (timer) clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
    },
    isTimeout: () => timedOut || (opts?.signal?.reason?.name === "TimeoutError"),
  };
}

/**
 * Pi AI raw image backend implementation using generateImages().
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
    const { signal, cleanup, isTimeout } = resolveSignal(opts);

    try {
      if (signal?.aborted) {
        const timeout = isTimeout();
        throw new InferenceError({
          code: timeout ? "timeout" : "invalid_request",
          message: signal.reason?.message || (timeout ? "Pi image request timed out" : "Operation aborted"),
          providerAccount: target.providerAccount,
          model: target.model,
          retryable: timeout,
        });
      }

      const op = req.operation ?? "generate";
      if (op !== "generate") {
        throw new InferenceError({
          code: "unsupported_capability",
          message: `Pi image backend currently only supports "generate" operation, received "${op}"`,
          providerAccount: target.providerAccount,
          model: target.model,
          retryable: false,
        });
      }

      const secret = await lease.secret();
      const apiKey = secret.kind === "api_key" ? secret.value : undefined;

      const providerName = target.upstreamProvider;
      let model = this.imageModels.getModel(providerName, target.model) as
        | ImagesModel<ImagesApi>
        | undefined;

      if (!model) {
        throw new InferenceError({
          code: "unsupported_capability",
          message: `Model "${target.model}" not found in Pi image catalog for provider "${target.upstreamProvider}"`,
          providerAccount: target.providerAccount,
          model: target.model,
          retryable: false,
        });
      }

      const inputContents: ImagesInputContent[] = [
        { type: "text", text: req.prompt },
      ];

      let result: AssistantImages;
      try {
        result = await this.imageModels.generateImages(
          model,
          { input: inputContents },
          {
            apiKey,
            signal,
            timeoutMs: opts?.timeoutMs,
          },
        );
      } catch (err: any) {
        if (signal?.aborted) {
          const timeout = isTimeout();
          throw new InferenceError({
            code: timeout ? "timeout" : "invalid_request",
            message: signal.reason?.message || (timeout ? "Pi image request timed out" : "Pi image request aborted by user"),
            providerAccount: target.providerAccount,
            model: target.model,
            retryable: timeout,
            cause: err,
          });
        }
        const classified = classifyInferenceError(err?.message || "", false);
        throw new InferenceError({
          code: classified.code,
          message: err?.message || "Pi image generation failed",
          providerAccount: target.providerAccount,
          model: target.model,
          retryable: classified.retryable,
          retryAfterMs: classified.retryAfterMs,
          cause: err,
        });
      }

      if (result.stopReason === "error") {
        throw new InferenceError({
          code: "internal_adapter",
          message: result.errorMessage || "Pi image generation failed with error stopReason",
          providerAccount: target.providerAccount,
          model: target.model,
          retryable: true,
        });
      }

      if (result.stopReason === "aborted") {
        throw new InferenceError({
          code: "timeout",
          message: "Pi image request was aborted",
          providerAccount: target.providerAccount,
          model: target.model,
          retryable: true,
        });
      }

      const images: ImageResult["images"] = [];
      for (const item of result.output || []) {
        if (item.type === "image") {
          images.push({
            mimeType: item.mimeType || "image/png",
            base64: item.data,
          });
        }
      }

      if (images.length === 0) {
        throw new InferenceError({
          code: "malformed_response",
          message: "Pi image backend produced 0 image items in output",
          providerAccount: target.providerAccount,
          model: target.model,
          retryable: false,
        });
      }

      return { images };
    } finally {
      cleanup();
      await lease.release();
    }
  }
}
