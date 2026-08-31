/**
 * Media capability — vendor-neutral image generation and prompt optimization.
 *
 * Tools and CLI commands declare intent ("generate an image", "optimize this prompt");
 * this capability resolves and executes them through ProviderRuntime (010 architecture).
 */

import * as fs from 'fs';
import * as path from 'path';
import type { FileCommitBroker } from '../../foundations/contracts/execution-brokers.js';
import type { CapabilityEnvelope } from '../../foundations/contracts/permission-policy.js';

export interface ImageRequest {
  prompt?: string;
  outputPath?: string;
  destinations?: string[];
  imagePath?: string;
  maskPath?: string;
  mode?: 'text-to-image' | 'variation' | 'edit';
  model?: string;
  n?: number;
  size?: string;
  quality?: string;
  style?: string;
  outputDir?: string;
}

export interface MediaConfig {
  model?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  runtime?: any;
  commitBroker?: FileCommitBroker;
  envelope?: CapabilityEnvelope;
}

export interface RuntimeImageOutput {
  bytes: Uint8Array;
  mimeType: string;
  base64?: string;
  url?: string;
  revisedPrompt?: string;
}

export interface RuntimeImageExecutionResult {
  images: RuntimeImageOutput[];
  servedBy?: {
    providerAccount: string;
    model: string;
  };
}

export interface StructuredImageResult {
  success: boolean;
  files: string[];
  error?: string;
  errorType?: "auth" | "rate_limit" | "timeout" | "provider_unavailable" | "invalid_request";
  status?: number;
}

/**
 * Execute image generation via ProviderRuntime without performing filesystem writes.
 * Used by the effect broker / vendorOperationHandler for pipeline-managed exact commits.
 */
export async function generateImageRuntime(
  req: ImageRequest,
  runtime: any,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<RuntimeImageExecutionResult> {
  const mode = req.mode ?? (req.imagePath && req.maskPath ? "edit" : req.imagePath ? "variation" : "text-to-image");

  if (mode === "text-to-image" && (!req.prompt || req.prompt.trim() === "")) {
    throw new Error("Prompt cannot be empty for image generation.");
  }

  if ((mode === "variation" || mode === "edit") && (!req.imagePath || !fs.existsSync(req.imagePath))) {
    throw new Error(`Input image path "${req.imagePath}" not found.`);
  }

  const snapshot = await runtime.createTurnSnapshot();
  const plan = await runtime.resolvePlan(
    snapshot,
    "image-generation",
    "standard",
    req.model ? { model: req.model } : undefined,
  );
  const operation = mode === "variation" ? "variation" : mode === "edit" ? "edit" : "generate";

  let aspectRatio: any = "1:1";
  if (req.size === "1792x1024" || req.size === "1536x1024" || req.size === "2560x1440") {
    aspectRatio = "16:9";
  } else if (req.size === "1024x1792" || req.size === "1024x1536" || req.size === "1440x2560") {
    aspectRatio = "9:16";
  } else if (req.size === "1024x1024" || req.size === "2048x2048" || req.size === "512x512" || req.size === "256x256") {
    aspectRatio = "1:1";
  }

  let inputImage: any;
  if (req.imagePath && fs.existsSync(req.imagePath)) {
    inputImage = {
      type: "image" as const,
      mediaType: "image/png" as const,
      data: fs.readFileSync(req.imagePath).toString("base64"),
    };
  }

  let mask: any;
  if (req.maskPath && fs.existsSync(req.maskPath)) {
    mask = {
      type: "image" as const,
      mediaType: "image/png" as const,
      data: fs.readFileSync(req.maskPath).toString("base64"),
    };
  }

  const result = await runtime.executeImage(
    plan,
    {
      prompt: req.prompt || "",
      operation,
      count: req.n || 1,
      qualityPreset: req.quality === "hd" || req.quality === "high" ? "high" : "standard",
      aspectRatio,
      style: req.style === "natural" ? "natural" : "vivid",
      inputImage,
      mask,
    },
    {
      signal,
      timeoutMs,
    },
  );

  const images: RuntimeImageOutput[] = [];
  for (const img of result.images) {
    let rawBytes: Uint8Array;
    const rawBase64 = (img as any).bytes ?? img.base64;
    if (rawBase64) {
      rawBytes = typeof rawBase64 === "string" ? Buffer.from(rawBase64, "base64") : rawBase64;
    } else if (img.url) {
      const response = await fetch(img.url, { signal });
      if (!response.ok) throw new Error(`Failed to download image from URL: ${response.statusText}`);
      const ab = await response.arrayBuffer();
      rawBytes = new Uint8Array(ab);
    } else {
      throw new Error("Provider returned image without bytes, base64, or url.");
    }
    images.push({
      bytes: rawBytes,
      mimeType: (img as any).mimeType || "image/png",
      base64: typeof rawBase64 === "string" ? rawBase64 : Buffer.from(rawBytes).toString("base64"),
      url: img.url,
      revisedPrompt: (img as any).revisedPrompt,
    });
  }

  return {
    images,
    servedBy: plan.selectedTarget
      ? {
          providerAccount: plan.selectedTarget.providerAccount,
          model: plan.selectedTarget.model,
        }
      : undefined,
  };
}

/**
 * Generate images and save them to files. Used by `seepient models image` CLI command.
 */
export async function generateImagesStructured(
  req: ImageRequest,
  config: MediaConfig,
): Promise<StructuredImageResult> {
  if (!config.runtime) {
    return {
      success: false,
      files: [],
      error: "Error: No ProviderRuntime configured for image generation. Assign an image provider in /models.",
      errorType: "invalid_request",
      status: 400,
    };
  }

  if (!config.commitBroker || !config.envelope) {
    return {
      success: false,
      files: [],
      error: "Exact-commit broker and capability envelope are required for image file output; write refused.",
      errorType: "invalid_request",
      status: 400,
    };
  }

  const generatedFiles: string[] = [];
  try {
    const execResult = await generateImageRuntime(req, config.runtime, config.signal, config.timeoutMs);

    if (req.outputPath) {
      const resolvedPath = path.resolve(req.outputPath);
      for (let i = 0; i < execResult.images.length; i++) {
        let dest = resolvedPath;
        if (i > 0) {
          const ext = path.extname(resolvedPath);
          const base = ext ? resolvedPath.slice(0, -ext.length) : resolvedPath;
          dest = `${base}-${i + 1}${ext || ".png"}`;
        }
        await config.commitBroker.commit({
          envelope: config.envelope,
          destination: dest,
          content: execResult.images[i].bytes,
        });
        generatedFiles.push(dest);
      }
    } else {
      const resolvedOutputDir = path.resolve(req.outputDir ?? ".");
      for (let i = 0; i < execResult.images.length; i++) {
        const img = execResult.images[i];
        const dest = req.destinations?.[i] ?? path.join(resolvedOutputDir, `generated-${Date.now()}-${i + 1}.png`);
        await config.commitBroker.commit({
          envelope: config.envelope,
          destination: dest,
          content: img.bytes,
        });
        generatedFiles.push(dest);
      }
    }

    return {
      success: true,
      files: generatedFiles,
    };
  } catch (err: any) {
    let errorType: StructuredImageResult["errorType"] = "invalid_request";
    let status = 400;
    if (err.code === "auth") {
      errorType = "auth";
      status = 401;
    } else if (err.code === "rate_limit") {
      errorType = "rate_limit";
      status = 429;
    } else if (err.code === "timeout") {
      errorType = "timeout";
      status = 408;
    } else if (
      err.code === "provider_unavailable" ||
      err.code === "network" ||
      err.code === "overload"
    ) {
      errorType = "provider_unavailable";
      status = 503;
    }

    return {
      success: false,
      files: generatedFiles,
      error: `Error generating image: ${err.message}`,
      errorType,
      status,
    };
  }
}

export async function optimizePrompt(
  rawPrompt: string,
  context: string | undefined,
  config: MediaConfig,
): Promise<string> {
  const contextMsg = context ? `Context: ${context}` : "Context: General AI Assistant interaction.";

  if (!config?.runtime) {
    throw new Error("No ProviderRuntime configured for prompt optimization. Please configure a model in /models.");
  }

  const runtime = config.runtime;
  const snapshot = await runtime.createTurnSnapshot();
  const plan = await runtime.resolvePlan(snapshot, "text", "efficient");
  let optimizedText = "";
  for await (const event of runtime.executeLanguage(
    plan,
    {
      messages: [
        {
          role: "system",
          content: [
            {
              type: "text",
              text: `You are an expert Prompt Engineer. Your goal is to rewrite the user's raw prompt to be clear, precise, and highly effective for LLMs or professional communication.

RULES:
1. Preserve the original intent.
2. Structure the prompt logically (e.g., Role, Context, Task, Constraints, Output Format).
3. Use professional and concise language.
4. Return ONLY the optimized prompt. Do not add conversational filler.`,
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Raw Prompt: "${rawPrompt}"\n\n${contextMsg}\n\nPlease optimize this prompt.`,
            },
          ],
        },
      ],
    },
    {
      signal: config.signal,
      timeoutMs: config.timeoutMs,
    },
  )) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      optimizedText += event.delta.text;
    }
  }
  if (optimizedText.trim()) {
    return optimizedText.trim();
  }
  throw new Error("Failed to generate optimized prompt from runtime.");
}
