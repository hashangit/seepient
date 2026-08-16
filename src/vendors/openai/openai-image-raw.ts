import * as fs from "node:fs";
import { OpenAI } from "openai";
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

      const params = canonicalToOpenAIImageParams(req);
      const op = req.operation ?? "generate";

      let response: any;
      try {
        if (op === "generate") {
          response = await client.images.generate(
            {
              model: target.model,
              prompt: params.prompt,
              n: params.n,
              quality: params.quality,
              size: params.size,
              response_format: "b64_json",
            },
            { signal: opts?.signal },
          );
        } else if (op === "variation") {
          if (!params.inputImagePath || !fs.existsSync(params.inputImagePath)) {
            throw new InferenceError({
              code: "invalid_request",
              message: `Image variation requires a valid existing input image at ${params.inputImagePath}`,
              providerAccount: target.providerAccount,
              model: target.model,
              retryable: false,
            });
          }
          response = await client.images.createVariation(
            {
              image: fs.createReadStream(params.inputImagePath),
              model: target.model,
              n: params.n,
              size: params.size as any,
              response_format: "b64_json",
            },
            { signal: opts?.signal },
          );
        } else if (op === "edit" || op === "mask") {
          if (!params.inputImagePath || !fs.existsSync(params.inputImagePath)) {
            throw new InferenceError({
              code: "invalid_request",
              message: `Image edit requires a valid existing input image at ${params.inputImagePath}`,
              providerAccount: target.providerAccount,
              model: target.model,
              retryable: false,
            });
          }
          const editParams: any = {
            image: fs.createReadStream(params.inputImagePath),
            prompt: params.prompt,
            model: target.model,
            n: params.n,
            size: params.size as any,
            response_format: "b64_json",
          };
          if (params.maskPath && fs.existsSync(params.maskPath)) {
            editParams.mask = fs.createReadStream(params.maskPath);
          }
          response = await client.images.edit(editParams, { signal: opts?.signal });
        }
      } catch (err: any) {
        if (err instanceof InferenceError) throw err;
        const status = err.status || err.response?.status;
        let code: any = "invalid_request";
        let retryable = false;

        if (status === 401 || status === 403) {
          code = "auth";
        } else if (status === 429) {
          code = "rate_limit";
          retryable = true;
        } else if (err.name === "AbortError" || err.name === "APIUserAbortError" || err.message?.includes("aborted") || err.message?.includes("timed out")) {
          code = "timeout";
          retryable = true;
        } else if (status && status >= 500) {
          code = "provider_unavailable";
          retryable = true;
        }

        throw new InferenceError({
          code,
          message: err.message || "OpenAI image request failed",
          providerAccount: target.providerAccount,
          model: target.model,
          retryable,
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
