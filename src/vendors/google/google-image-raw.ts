import { GoogleGenAI, Modality } from "@google/genai";
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
import { canonicalToGoogleImagePayload } from "./google-canonical-converter.js";

/**
 * Raw Google image backend executing via `@google/genai`.
 */
export class GoogleImageRaw implements ImageBackend {
  private client?: GoogleGenAI;

  constructor(customClient?: GoogleGenAI) {
    this.client = customClient;
  }

  async generate(
    target: InferenceTarget,
    req: ImageRequest,
    opts?: InferenceOptions,
  ): Promise<ImageResult> {
    const lease = target.credential.acquireLease();

    let onAbort: (() => void) | undefined;
    try {
      const secret = await lease.secret();
      if (secret.kind !== "api_key") {
        throw new InferenceError({
          code: "auth",
          message: `Google image backend requires an api_key credential, received kind "${secret.kind}"`,
          providerAccount: target.providerAccount,
          model: target.model,
          retryable: false,
        });
      }

      const ai =
        this.client ??
        new GoogleGenAI({
          apiKey: secret.value,
        });

      if (opts?.signal?.aborted) {
        const timeout = opts.signal.reason?.name === "TimeoutError";
        throw new InferenceError({
          code: timeout ? "timeout" : "invalid_request",
          message: opts.signal.reason?.message || (timeout ? "Google image request timed out" : "Google image request aborted by user"),
          providerAccount: target.providerAccount,
          model: target.model,
          retryable: timeout,
        });
      }

      const controller = new AbortController();
      onAbort = () => controller.abort(opts?.signal?.reason);
      if (opts?.signal) {
        if (opts.signal.aborted) {
          controller.abort(opts.signal.reason);
        } else {
          opts.signal.addEventListener("abort", onAbort);
        }
      }
      const payload = canonicalToGoogleImagePayload(req);
      const signal = controller.signal;

      let response: any;
      try {
        const generatePromise = ai.models.generateContent({
          model: target.model,
          contents: payload.contents,
          config: {
            responseModalities: [Modality.IMAGE, Modality.TEXT],
            abortSignal: signal,
            ...(req.aspectRatio ? { imageConfig: { aspectRatio: req.aspectRatio } } : {}),
          } as any,
        });

        if (opts?.timeoutMs && opts.timeoutMs > 0) {
          let timeoutHandle: any;
          const timeoutPromise = new Promise((_, reject) => {
            timeoutHandle = setTimeout(() => {
              controller.abort(new Error(`Timeout after ${opts.timeoutMs}ms`));
              reject(new InferenceError({
                code: "timeout",
                message: `Google image request timed out after ${opts.timeoutMs}ms`,
                providerAccount: target.providerAccount,
                model: target.model,
                retryable: true,
              }));
            }, opts.timeoutMs);
          });
          try {
            response = await Promise.race([generatePromise, timeoutPromise]);
          } finally {
            clearTimeout(timeoutHandle);
          }
        } else {
          response = await generatePromise;
        }
      } catch (err: any) {
        if (err instanceof InferenceError) throw err;
        const isTimeout =
          err.name === "TimeoutError" ||
          err.message?.includes("timed out") ||
          (signal?.reason?.name === "TimeoutError");

        if (signal?.aborted && !isTimeout) {
          throw new InferenceError({
            code: "invalid_request",
            message: signal.reason?.message || "Google image request aborted by user",
            providerAccount: target.providerAccount,
            model: target.model,
            retryable: false,
            cause: err,
          });
        }
        const msg = String(err?.message || err);
        if (/not supported|unsupported/i.test(msg)) {
          throw new InferenceError({
            code: "unsupported_capability",
            message: `Model "${target.model}" does not support this image operation`,
            providerAccount: target.providerAccount,
            model: target.model,
            retryable: false,
            cause: err,
          });
        }
        const classified = classifyInferenceError(err, isTimeout);
        throw new InferenceError({
          code: classified.code,
          message: msg || "Google image generation failed",
          providerAccount: target.providerAccount,
          model: target.model,
          retryable: classified.retryable,
          retryAfterMs: classified.retryAfterMs,
          cause: err,
        });
      }

      const images: ImageResult["images"] = [];

      if (response?.candidates) {
        for (const candidate of response.candidates) {
          const parts = candidate?.content?.parts || [];
          for (const part of parts) {
            if (part.inlineData && part.inlineData.data) {
              images.push({
                mimeType: part.inlineData.mimeType || "image/png",
                base64: part.inlineData.data,
              });
            }
          }
        }
      }

      if (images.length === 0) {
        throw new InferenceError({
          code: "malformed_response",
          message: "Google Gemini returned a response but no image data was found in parts",
          providerAccount: target.providerAccount,
          model: target.model,
          retryable: false,
        });
      }

      return { images };
    } finally {
      if (opts?.signal && onAbort) {
        opts.signal.removeEventListener("abort", onAbort);
      }
      await lease.release();
    }
  }
}
