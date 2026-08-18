import { OpenAI, toFile } from "openai";
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
import { canonicalToOpenAIImageParams } from "./openai-canonical-converter.js";

/**
 * Raw OpenAI Image backend executing directly via the OpenAI SDK.
 */
export class OpenAIImageRaw implements ImageBackend {
  private client?: OpenAI;

  constructor(customClient?: OpenAI) {
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
          message: `OpenAI image backend requires an api_key credential, received kind "${secret.kind}"`,
          providerAccount: target.providerAccount,
          model: target.model,
          retryable: false,
        });
      }

      const client =
        this.client ??
        new OpenAI({
          apiKey: secret.value,
          baseURL: target.baseUrl,
          timeout: opts?.timeoutMs,
        });

      const params = canonicalToOpenAIImageParams(req, target.model);
      const op = req.operation ?? "generate";

      const isGptImage = target.model.includes("gpt-image");

      let response: any;
      try {
        if (op === "generate") {
          const genParams: any = {
            model: target.model,
            prompt: params.prompt,
            n: params.n,
            size: params.size,
          };
          if (!isGptImage) {
            genParams.response_format = "b64_json";
          }
          if (params.quality) {
            genParams.quality = params.quality;
          }
          response = await client.images.generate(genParams, { signal: opts?.signal });
        } else if (op === "variation") {
          if (!params.inputImageBuffer) {
            throw new InferenceError({
              code: "invalid_request",
              message: "Image variation requires an input image with base64 data",
              providerAccount: target.providerAccount,
              model: target.model,
              retryable: false,
            });
          }
          const file = await toFile(params.inputImageBuffer, "input.png", { type: "image/png" });
          const varParams: any = {
            image: file,
            model: target.model,
            n: params.n,
            size: params.size as any,
          };
          if (!isGptImage) {
            varParams.response_format = "b64_json";
          }
          response = await client.images.createVariation(varParams, { signal: opts?.signal });
        } else if (op === "edit" || op === "mask") {
          if (!params.inputImageBuffer) {
            throw new InferenceError({
              code: "invalid_request",
              message: "Image edit requires an input image with base64 data",
              providerAccount: target.providerAccount,
              model: target.model,
              retryable: false,
            });
          }
          const file = await toFile(params.inputImageBuffer, "input.png", { type: "image/png" });
          const editParams: any = {
            image: file,
            model: target.model,
            prompt: params.prompt,
            n: params.n,
            size: params.size as any,
          };
          if (!isGptImage) {
            editParams.response_format = "b64_json";
          }
          if (params.maskBuffer) {
            editParams.mask = await toFile(params.maskBuffer, "mask.png", { type: "image/png" });
          }
          response = await client.images.edit(editParams, { signal: opts?.signal });
        }
      } catch (err: any) {
        if (err instanceof InferenceError) throw err;
        const status = err.status || err.response?.status;
        const isTimeout =
          err.name === "TimeoutError" ||
          err.message?.includes("timed out") ||
          (opts?.signal?.reason?.name === "TimeoutError");

        if (opts?.signal?.aborted && !isTimeout) {
          throw new InferenceError({
            code: "invalid_request",
            message: opts.signal.reason?.message || "OpenAI image request aborted by user",
            providerAccount: target.providerAccount,
            model: target.model,
            retryable: false,
            cause: err,
          });
        }

        const classified = classifyInferenceError(err, isTimeout, status);
        throw new InferenceError({
          code: classified.code,
          message: err.message || "OpenAI image request failed",
          providerAccount: target.providerAccount,
          model: target.model,
          retryable: classified.retryable,
          retryAfterMs: classified.retryAfterMs,
          cause: err,
        });
      }

      const images: ImageResult["images"] = (response?.data || []).map((item: any) => ({
        mimeType: "image/png",
        url: item.url,
        base64: item.b64_json,
        revisedPrompt: item.revised_prompt,
      }));

      if (images.length === 0) {
        throw new InferenceError({
          code: "malformed_response",
          message: "OpenAI returned success but produced 0 image items",
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
