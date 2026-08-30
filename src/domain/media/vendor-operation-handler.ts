import type { ProviderRuntime } from "../providers/provider-runtime.js";
import type { InMemoryArtifactStore } from "../../capabilities/execution/in-memory-artifact-store.js";
import type { BrokeredEffectRequest, PreparedArtifactRef } from "../../foundations/contracts/prepared-action.js";
import type { BrokeredEffectResult } from "../../foundations/contracts/execution-brokers.js";
import type { StructuredToolError } from "../../foundations/contracts/execution-boundary.js";
import { InferenceError } from "../../foundations/errors.js";
import { createSetupFailure } from "../../foundations/contracts/setup-failure.js";

export interface MediaVendorOperationHandlerOptions {
  runtime: ProviderRuntime | (() => ProviderRuntime | undefined);
  artifacts: InMemoryArtifactStore;
  signal?: AbortSignal;
}

function classifyMediaError(
  err: unknown,
  operation: string,
  defaultCode: string,
): StructuredToolError {
  const code = (err as any)?.code;
  const providerAccount = (err as any)?.providerAccount;
  const rawMessage =
    err instanceof Error
      ? err.message
      : typeof (err as any)?.message === "string"
        ? (err as any).message
        : String(err);

  if (typeof code === "string") {
    if (code === "unconfigured_purpose" || code === "unconfigured_provider") {
      const setup = createSetupFailure(
        operation,
        "configured image provider",
        "an image model in /models or seepient.json",
      );
      return {
        code: "SETUP_REQUIRED",
        message: `${setup.message}\n${rawMessage}`,
        retryable: false,
      };
    }
    if (code === "auth" || code === "oauth_expired") {
      return {
        code: "AUTH_FAILED",
        message: `Image provider "${providerAccount ?? "configured provider"}" is not accessible: authentication failed (${rawMessage}). Check your API key.`,
        retryable: false,
      };
    }
    if (code === "rate_limit") {
      return {
        code: "RATE_LIMITED",
        message: `Image provider "${providerAccount ?? "configured provider"}" is not accessible: rate limit exceeded (${rawMessage}).`,
        retryable: true,
      };
    }
    if (code === "timeout") {
      return {
        code: "TIMEOUT",
        message: `Image provider "${providerAccount ?? "configured provider"}" is not accessible: request timed out (${rawMessage}).`,
        retryable: true,
      };
    }
    if (
      code === "provider_unavailable" ||
      code === "network" ||
      code === "overload"
    ) {
      return {
        code: "PROVIDER_UNAVAILABLE",
        message: `Image provider "${providerAccount ?? "configured provider"}" is not accessible: service unavailable or network error (${rawMessage}).`,
        retryable: true,
      };
    }
    if (code === "unsupported_capability") {
      return {
        code: "UNSUPPORTED_CAPABILITY",
        message: `Configured model does not support ${operation}: ${rawMessage}. Run /models to select a compatible model.`,
        retryable: false,
      };
    }
  }

  if (rawMessage.includes("No provider runtime") || rawMessage.includes("No ProviderRuntime")) {
    const setup = createSetupFailure(
      operation,
      "configured provider runtime",
      "an AI model in /models",
    );
    return {
      code: "SETUP_REQUIRED",
      message: setup.message,
      retryable: false,
    };
  }

  return {
    code: defaultCode,
    message: rawMessage,
    retryable: false,
  };
}

/**
 * Creates a brokered vendor-operation handler for media operations
 * (generate_image, optimize_prompt).
 */
export function createMediaVendorOperationHandler(
  opts: MediaVendorOperationHandlerOptions,
): (req: Extract<BrokeredEffectRequest, { kind: "vendor-operation" }>) => Promise<BrokeredEffectResult> {
  return async (
    req: Extract<BrokeredEffectRequest, { kind: "vendor-operation" }>,
  ): Promise<BrokeredEffectResult> => {
    const runtime = typeof opts.runtime === "function" ? opts.runtime() : opts.runtime;
    if (!runtime) {
      const setup = createSetupFailure(
        req.operation,
        "configured provider runtime",
        "an AI provider in /models",
      );
      return {
        requestId: req.requestId,
        status: "failed",
        error: {
          code: "SETUP_REQUIRED",
          message: setup.message,
          retryable: false,
        },
      };
    }

    if (req.connector === "media" && req.operation === "generate_image") {
      const { generateImageRuntime } = await import("../../capabilities/media/media.js");
      try {
        const execResult = await generateImageRuntime(req.input as any, runtime, opts.signal);
        if (execResult.images.length === 0) {
          return {
            requestId: req.requestId,
            status: "failed",
            error: {
              code: "MEDIA_GENERATION_FAILED",
              message: "No image data returned from provider.",
              retryable: false,
            },
          };
        }
        const artifactsList: PreparedArtifactRef[] = [];
        for (const img of execResult.images) {
          const art = await opts.artifacts.put(img.bytes, img.mimeType);
          artifactsList.push(art);
        }
        return {
          requestId: req.requestId,
          status: "succeeded",
          output: artifactsList[0],
          outputs: artifactsList,
        };
      } catch (err: any) {
        return {
          requestId: req.requestId,
          status: "failed",
          error: classifyMediaError(err, "generate_image", "MEDIA_GENERATION_FAILED"),
        };
      }
    }

    if (req.connector === "media" && req.operation === "optimize_prompt") {
      const { optimizePrompt } = await import("../../capabilities/media/media.js");
      try {
        const input = req.input as { raw_prompt: string; context?: string };
        const text = await optimizePrompt(input.raw_prompt, input.context, {
          runtime,
          signal: opts.signal,
        });
        const artifact = await opts.artifacts.put(new TextEncoder().encode(text), "text/plain");
        return {
          requestId: req.requestId,
          status: "succeeded",
          output: artifact,
        };
      } catch (err: any) {
        return {
          requestId: req.requestId,
          status: "failed",
          error: classifyMediaError(err, "optimize_prompt", "PROMPT_OPTIMIZATION_FAILED"),
        };
      }
    }

    return {
      requestId: req.requestId,
      status: "denied",
      error: {
        code: "VENDOR_OP_UNSUPPORTED",
        message: `Unsupported vendor operation ${req.connector}/${req.operation}`,
        retryable: false,
      },
    };
  };
}
