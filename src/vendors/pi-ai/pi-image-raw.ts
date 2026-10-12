import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { assertBaseUrlEgressAllowed } from "../egress-check.js";
import type {
  ImageModel,
  ImageApi,
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
  private models: any;

  constructor(customModels?: any) {
    // Credentials flow per-call (options.apiKey, always explicit — see the
    // sentinel below), so the 0.87 collection's credential store is gone.
    this.models = customModels ?? builtinModels();
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

      const rawSecret = await lease.secret();
      // 022-5 FR-007 (tenancy-invariant): undefined/empty keys must never
      // reach the vendored layer — it falls back to host environment keys.
      // kind:"none" maps to the explicit "unused" sentinel (no-auth endpoint):
      // resolveProviderAuth's explicit-key short-circuit (auth/resolve.js)
      // returns before any credential-store or ambient env read.
      const secret = rawSecret?.kind === "none" ? { kind: "api_key" as const, value: "unused" } : rawSecret;
      if (!secret || secret.kind !== "api_key" || !secret.value) {
        throw new InferenceError({
          code: "auth",
          message: `CREDENTIAL_REQUIRED: Image inference requires an explicit api_key credential for provider "${target.upstreamProvider}" — put an api_key record in your credential store and reference it from the provider entry as credential: { kind: "seepient", id }.`,
          providerAccount: target.providerAccount,
          model: target.model,
          retryable: false,
        });
      }
      if (opts?.tenancyMode === "multi" && target.baseUrl) {
        assertBaseUrlEgressAllowed(target.baseUrl, opts.capabilities, target);
      }

      const apiKey = secret.value;

      const providerName = target.upstreamProvider;
      let model = this.models.getModelOfType("image", providerName, target.model) as
        | ImageModel<ImageApi>
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

      if (target.baseUrl) {
        model = { ...model, baseUrl: target.baseUrl };
      }

      const inputContents: ImagesInputContent[] = [
        { type: "text", text: req.prompt },
      ];

      let result: AssistantImages;
      try {
        result = await this.models.generateImages(
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
        // 1.0 delivers vendor failures as results, so this branch — not the
        // catch below — is the primary failure channel. Classify like the
        // throw path: a permanent 401 must stay non-retryable instead of
        // triggering cross-account failover.
        const classified = classifyInferenceError(result.errorMessage || "", false);
        throw new InferenceError({
          code: classified.code,
          message: result.errorMessage || "Pi image generation failed with error stopReason",
          providerAccount: target.providerAccount,
          model: target.model,
          retryable: classified.retryable,
          retryAfterMs: classified.retryAfterMs,
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
