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

      const payload = canonicalToGoogleImagePayload(req);
      const signal = opts?.signal;

      let response: any;
      try {
        const generatePromise = ai.models.generateContent({
          model: target.model,
          contents: payload.contents,
          config: {
            responseModalities: [Modality.IMAGE, Modality.TEXT],
            abortSignal: signal,
          } as any,
        });

        if (opts?.timeoutMs && opts.timeoutMs > 0) {
          let timeoutHandle: any;
          const timeoutPromise = new Promise((_, reject) => {
            timeoutHandle = setTimeout(() => {
              reject(new InferenceError({
                code: "timeout",
                message: `Google image request timed out after ${opts.timeoutMs}ms`,
                providerAccount: target.providerAccount,
                model: target.model,
                retryable: true,
              }));
            }, opts.timeoutMs);
          });
          response = await Promise.race([generatePromise, timeoutPromise]);
          clearTimeout(timeoutHandle);
        } else {
          response = await generatePromise;
        }
      } catch (err: any) {
        if (err instanceof InferenceError) throw err;
        if (signal?.aborted) {
          throw new InferenceError({
            code: "timeout",
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
        if (/api key|auth|credential/i.test(msg)) {
          throw new InferenceError({
            code: "auth",
            message: msg,
            providerAccount: target.providerAccount,
            model: target.model,
            retryable: false,
            cause: err,
          });
        }
        throw new InferenceError({
          code: "network",
          message: msg,
          providerAccount: target.providerAccount,
          model: target.model,
          retryable: true,
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
      await lease.release();
    }
  }
}
