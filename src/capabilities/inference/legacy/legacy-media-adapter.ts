import * as fs from "node:fs";
import type {
  ImageBackend,
  InferenceTarget,
  InferenceOptions,
} from "../../../foundations/contracts/backend-ports.js";
import type {
  ImageRequest,
  ImageResult,
  ImageBlock,
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
  };
}

function resolveImageBlockPath(block?: ImageBlock): string | undefined {
  if (!block) return undefined;
  if ("url" in block && typeof block.url === "string") return block.url;
  if ("artifact" in block && typeof block.artifact === "object" && block.artifact !== null) {
    return block.artifact.ref;
  }
  return undefined;
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

      const inputImagePath = resolveImageBlockPath(req.inputImage);
      const maskPath = resolveImageBlockPath(req.mask);
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
            signal,
            timeoutMs: opts?.timeoutMs,
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
        const errorType = structuredResult.errorType || "invalid_request";
        const isRetryable = errorType === "rate_limit" || errorType === "provider_unavailable" || errorType === "timeout";
        throw new InferenceError({
          code: errorType,
          message: structuredResult.error || "Image generation failed",
          providerAccount: target.providerAccount,
          model: target.model,
          retryable: isRetryable,
        });
      }

      const images: ImageResult["images"] = structuredResult.files.map((item) => {
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
