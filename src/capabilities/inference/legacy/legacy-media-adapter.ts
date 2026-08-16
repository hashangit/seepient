import * as fs from "node:fs";
import type {
  ImageBackend,
  InferenceTarget,
  InferenceOptions,
} from "../../../foundations/contracts/backend-ports.js";
import type {
  ImageRequest,
  ImageResult,
} from "../../../foundations/schemas/inference.js";
import { generateImagesStructured } from "../../media/media.js";
import { InferenceError } from "../../../foundations/errors.js";

/** Combine AbortSignal and timeoutMs into a single effective AbortSignal */
function resolveSignal(opts?: InferenceOptions): { signal?: AbortSignal; cleanup: () => void } {
  if (!opts?.timeoutMs && !opts?.signal) {
    return { signal: undefined, cleanup: () => {} };
  }

  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;

  if (opts.timeoutMs && opts.timeoutMs > 0) {
    timer = setTimeout(() => {
      controller.abort(new Error(`Operation timed out after ${opts.timeoutMs}ms`));
    }, opts.timeoutMs);
  }

  if (opts.signal) {
    if (opts.signal.aborted) {
      controller.abort(opts.signal.reason);
    } else {
      opts.signal.addEventListener("abort", () => controller.abort(opts.signal?.reason), { once: true });
    }
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      if (timer) clearTimeout(timer);
    },
  };
}

/**
 * Legacy media adapter implementing ImageBackend using OpenAI image APIs.
 */
export class LegacyMediaAdapter implements ImageBackend {
  async generate(
    target: InferenceTarget,
    req: ImageRequest,
    opts?: InferenceOptions,
  ): Promise<ImageResult> {
    const lease = target.credential.acquireLease();
    const { signal, cleanup } = resolveSignal(opts);

    try {
      if (signal?.aborted) {
        throw new InferenceError({
          code: "timeout",
          message: signal.reason?.message || "Operation aborted",
          providerAccount: target.providerAccount,
          model: target.model,
          retryable: false,
        });
      }

      const secret = await lease.secret();

      if (secret.kind !== "api_key") {
        throw new InferenceError({
          code: "auth",
          message: `Legacy media adapter requires an api_key credential, received kind "${secret.kind}"`,
          providerAccount: target.providerAccount,
          model: target.model,
          retryable: false,
        });
      }

      if (target.upstreamProvider !== "openai" && target.upstreamProvider !== "openai-compatible") {
        throw new InferenceError({
          code: "unsupported_capability",
          message: `Legacy media adapter does not support upstream provider "${target.upstreamProvider}"`,
          providerAccount: target.providerAccount,
          model: target.model,
          retryable: false,
        });
      }

      const legacyMode =
        req.operation === "generate"
          ? "text-to-image"
          : req.operation === "variation"
            ? "variation"
            : req.operation === "edit" || req.operation === "mask"
              ? "edit"
              : undefined;

      const inputImagePath =
        typeof req.inputImage === "string"
          ? req.inputImage
          : typeof req.inputImage === "object" && req.inputImage !== null
            ? (req.inputImage as any).url || (req.inputImage as any).path
            : undefined;

      const maskPath =
        typeof req.mask === "string"
          ? req.mask
          : typeof req.mask === "object" && req.mask !== null
            ? (req.mask as any).url || (req.mask as any).path
            : undefined;

      const legacyQuality = req.qualityPreset === "high" ? "hd" : "standard";

      let structuredResult;
      try {
        structuredResult = await generateImagesStructured(
          {
            prompt: req.prompt,
            imagePath: inputImagePath,
            maskPath,
            mode: legacyMode,
            model: target.model,
            n: req.count ?? 1,
            quality: legacyQuality,
            style: req.style,
            outputDir: req.outputDir,
          },
          {
            apiKey: secret.value,
            baseUrl: target.baseUrl,
          },
        );
      } catch (err: any) {
        const isTimeout = signal?.aborted;
        throw new InferenceError({
          code: isTimeout ? "timeout" : "network",
          message: err?.message || "Failed to generate image via media backend",
          providerAccount: target.providerAccount,
          model: target.model,
          retryable: true,
          cause: err,
        });
      }

      if (!structuredResult.success || structuredResult.error) {
        throw new InferenceError({
          code: "invalid_request",
          message: structuredResult.error || "Image generation failed",
          providerAccount: target.providerAccount,
          model: target.model,
          retryable: false,
        });
      }

      const images = structuredResult.files.map((item) => {
        if (item.startsWith("http://") || item.startsWith("https://")) {
          return {
            mimeType: "image/png",
            url: item,
          };
        }
        try {
          if (fs.existsSync(item)) {
            const buffer = fs.readFileSync(item);
            return {
              mimeType: "image/png",
              base64: buffer.toString("base64"),
            };
          }
        } catch {
          // Fall through
        }
        return item.includes("://")
          ? { mimeType: "image/png", url: item }
          : { mimeType: "image/png", base64: item };
      });

      if (images.length === 0) {
        throw new InferenceError({
          code: "malformed_response",
          message: "Media backend returned success but produced 0 image files",
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
