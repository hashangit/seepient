/**
 * Media capability — vendor-neutral image generation and prompt optimization.
 *
 * Tools declare intent ("generate an image", "optimize this prompt"); this
 * capability carries it out. The only vendor it knows today is OpenAI, reached
 * through the vendors/ quarantine — never imported directly.
 */

import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { OpenAI } from '../../vendors/openai.js';

export interface ImageRequest {
  prompt?: string;
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
  apiKey?: string;
  baseUrl?: string;
  imageApiKey?: string;
  imageBaseUrl?: string;
  imageModel?: string;
  imageN?: number;
  imageSize?: string;
  imageQuality?: string;
  imageStyle?: string;
  model?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  runtime?: any;
}

async function downloadImage(url: string, destPath: string, signal?: AbortSignal): Promise<void> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Failed to download image: ${response.statusText}`);
  const buffer = await response.arrayBuffer();
  fs.writeFileSync(destPath, Buffer.from(buffer));
}

export interface StructuredImageResult {
  success: boolean;
  files: string[];
  error?: string;
  errorType?: "auth" | "rate_limit" | "timeout" | "provider_unavailable" | "invalid_request";
  status?: number;
}

export async function generateImagesStructured(
  req: ImageRequest,
  config: MediaConfig,
): Promise<StructuredImageResult> {
  if (config.runtime) {
    try {
      const runtime = config.runtime;
      const snapshot = await runtime.createTurnSnapshot();
      const plan = await runtime.resolvePlan(
        snapshot,
        "image-generation",
        undefined,
        req.model ? { model: req.model } : undefined,
      );
      const operation = req.mode === "variation" ? "variation" : req.mode === "edit" ? "edit" : "generate";

      let aspectRatio: any;
      if (req.size === "1792x1024" || req.size === "1536x1024") aspectRatio = "16:9";
      else if (req.size === "1024x1792" || req.size === "1024x1536") aspectRatio = "9:16";
      else if (req.size === "1024x1024") aspectRatio = "1:1";

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
          inputImage,
          mask,
        },
        {
          signal: config.signal,
          timeoutMs: config.timeoutMs,
        },
      );

      const generatedFiles: string[] = [];
      const resolvedOutputDir = path.resolve(req.outputDir ?? ".");
      if (!fs.existsSync(resolvedOutputDir)) {
        fs.mkdirSync(resolvedOutputDir, { recursive: true });
      }

      for (let i = 0; i < result.images.length; i++) {
        const img = result.images[i];
        const fileName = `generated-${Date.now()}-${i + 1}.png`;
        const filePath = path.join(resolvedOutputDir, fileName);
        if (img.base64) {
          fs.writeFileSync(filePath, Buffer.from(img.base64, "base64"));
          generatedFiles.push(filePath);
        } else if (img.url) {
          await downloadImage(img.url, filePath, config.signal);
          generatedFiles.push(filePath);
        }
      }

      return {
        success: true,
        files: generatedFiles,
      };
    } catch (err: any) {
      return {
        success: false,
        files: [],
        error: `Error generating image: ${err.message}`,
        errorType: err.code === "auth" ? "auth" : "invalid_request",
        status: err.code === "auth" ? 401 : 400,
      };
    }
  }
  const apiKey = config.imageApiKey || config.apiKey || process.env.OPENAI_API_KEY;
  const baseURL = config.imageBaseUrl || config.baseUrl || process.env.OPENAI_COMPAT_BASE_URL || process.env.OPENAI_BASE_URL;

  if (!apiKey) {
    return {
      success: false,
      files: [],
      error: "Error: Image Service API Key is missing. Please configure it in .seepient/setting.json (imageApiKey or apiKey).",
      errorType: "auth",
      status: 401,
    };
  }

  const client = new OpenAI({
    apiKey: apiKey,
    baseURL: baseURL,
    timeout: config.timeoutMs,
  });

  const { prompt, imagePath, maskPath } = req;
  const outputDir = req.outputDir ?? ".";

  const n = req.n || config.imageN || 1;

  let mode = req.mode;
  let model = req.model;
  if (config.imageModel && (!model || model === "dall-e-3")) {
    model = config.imageModel;
  }
  model = model || "dall-e-3";

  let defaultSize = "1024x1024";
  if (model.toLowerCase().includes("doubao")) {
    defaultSize = "2048x2048";
  }

  const size = req.size || config.imageSize || defaultSize;
  const quality = req.quality || config.imageQuality || "standard";
  const style = req.style || config.imageStyle || "vivid";

  if (!mode) {
    if (imagePath && maskPath) mode = "edit";
    else if (imagePath) mode = "variation";
    else mode = "text-to-image";
  }

  if (mode === "text-to-image") {
    if (model === "dall-e-3") {
      const validSizes = ["1024x1024", "1024x1792", "1792x1024"];
      if (!validSizes.includes(size)) {
        return {
          success: false,
          files: [],
          error: `Error: Invalid size '${size}' for DALL-E 3. Supported sizes are: ${validSizes.join(", ")}.`,
        };
      }
    } else if (model === "dall-e-2") {
      const validSizes = ["256x256", "512x512", "1024x1024"];
      if (!validSizes.includes(size)) {
        return {
          success: false,
          files: [],
          error: `Error: Invalid size '${size}' for DALL-E 2. Supported sizes are: ${validSizes.join(", ")}.`,
        };
      }
    }
  } else {
    if (model === "dall-e-3") {
      console.log("Note: DALL-E 3 does not support variation/edit. Falling back to DALL-E 2.");
      model = "dall-e-2";
    }
  }

  const resolvedOutputDir = path.resolve(process.cwd(), outputDir);
  if (!fs.existsSync(resolvedOutputDir)) {
    fs.mkdirSync(resolvedOutputDir, { recursive: true });
  }

  const generatedFiles: string[] = [];

  try {
    if (mode === "text-to-image") {
      if (!prompt) {
        return {
          success: false,
          files: [],
          error: "Error: 'prompt' is required for text-to-image mode.",
        };
      }

      console.log(`Generating ${n} image(s) with ${model} (${size}, ${quality})...`);

      if (model === "dall-e-3") {
        for (let i = 0; i < n; i++) {
          const response = await client.images.generate(
            {
              model: "dall-e-3",
              prompt: prompt,
              n: 1,
              size: size as any,
              quality: quality as any,
              style: style as any,
              response_format: "url",
            },
            { signal: config.signal },
          );

          const imageUrl = response.data?.[0]?.url;
          if (imageUrl) {
            const fileName = `generated-${Date.now()}-${i + 1}.png`;
            const filePath = path.join(resolvedOutputDir, fileName);
            await downloadImage(imageUrl, filePath, config.signal);
            generatedFiles.push(filePath);
          }
        }
      } else {
        const response = await client.images.generate(
          {
            model: model,
            prompt: prompt,
            n: n,
            size: size as any,
            response_format: "url",
          },
          { signal: config.signal },
        );

        const data = response.data || [];
        for (let i = 0; i < data.length; i++) {
          const imageUrl = data[i].url;
          if (imageUrl) {
            const fileName = `generated-${Date.now()}-${i + 1}.png`;
            const filePath = path.join(resolvedOutputDir, fileName);
            await downloadImage(imageUrl, filePath, config.signal);
            generatedFiles.push(filePath);
          }
        }
      }
    } else if (mode === "variation") {
      if (!imagePath) {
        return {
          success: false,
          files: [],
          error: "Error: 'image_path' is required for variation mode.",
        };
      }
      if (!fs.existsSync(imagePath)) {
        return {
          success: false,
          files: [],
          error: `Error: Image file not found at ${imagePath}`,
        };
      }

      console.log(`Generating ${n} variation(s) with ${model}...`);

      const response = await client.images.createVariation(
        {
          image: fs.createReadStream(imagePath),
          n: n,
          model: "dall-e-2",
          size: size as any,
          response_format: "url",
        },
        { signal: config.signal },
      );

      const data = response.data || [];
      for (let i = 0; i < data.length; i++) {
        const imageUrl = data[i].url;
        if (imageUrl) {
          const fileName = `variation-${Date.now()}-${i + 1}.png`;
          const filePath = path.join(resolvedOutputDir, fileName);
          await downloadImage(imageUrl, filePath, config.signal);
          generatedFiles.push(filePath);
        }
      }
    } else if (mode === "edit") {
      if (!imagePath) {
        return {
          success: false,
          files: [],
          error: "Error: 'image_path' is required for edit mode.",
        };
      }
      if (!prompt) {
        return {
          success: false,
          files: [],
          error: "Error: 'prompt' is required for edit mode.",
        };
      }
      if (!fs.existsSync(imagePath)) {
        return {
          success: false,
          files: [],
          error: `Error: Image file not found at ${imagePath}`,
        };
      }

      console.log(`Editing image with ${model}...`);

      const params: any = {
        image: fs.createReadStream(imagePath),
        prompt: prompt,
        n: n,
        model: "dall-e-2",
        size: size as any,
        response_format: "url",
      };

      if (maskPath && fs.existsSync(maskPath)) {
        params.mask = fs.createReadStream(maskPath);
      }

      const response = await client.images.edit(params, { signal: config.signal });

      const data = response.data || [];
      for (let i = 0; i < data.length; i++) {
        const imageUrl = data[i].url;
        if (imageUrl) {
          const fileName = `edited-${Date.now()}-${i + 1}.png`;
          const filePath = path.join(resolvedOutputDir, fileName);
          await downloadImage(imageUrl, filePath, config.signal);
          generatedFiles.push(filePath);
        }
      }
    } else {
      return {
        success: false,
        files: [],
        error: `Error: Unknown mode '${mode}'.`,
      };
    }

    return {
      success: true,
      files: generatedFiles,
    };
  } catch (error: any) {
    console.error(chalk.red(`Image Generation Failed: ${error.message}`));
    if (error.response && error.response.data) {
      console.error(chalk.dim(JSON.stringify(error.response.data)));
    }
    let errorType: StructuredImageResult["errorType"] = "invalid_request";
    const status = error.status || error.response?.status;
    if (status === 401 || status === 403) {
      errorType = "auth";
    } else if (status === 429) {
      errorType = "rate_limit";
    } else if (error.name === "AbortError" || error.name === "APIUserAbortError" || error.message?.includes("aborted") || error.message?.includes("timed out")) {
      errorType = "timeout";
    } else if (status && status >= 500) {
      errorType = "provider_unavailable";
    }

    return {
      success: false,
      files: [],
      error: `Error generating image: ${error.message}`,
      errorType,
      status,
    };
  }
}

export async function generateImages(req: ImageRequest, config: MediaConfig): Promise<string> {
  const res = await generateImagesStructured(req, config);
  if (!res.success || res.error) {
    return res.error ?? "Error generating image.";
  }
  return `Successfully generated ${res.files.length} image(s):\n${res.files.join("\n")}`;
}

export async function optimizePrompt(
  rawPrompt: string,
  context: string | undefined,
  config: MediaConfig,
): Promise<string> {
  const contextMsg = context ? `Context: ${context}` : "Context: General AI Assistant interaction.";

  if (config?.runtime) {
    try {
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
    } catch (err: any) {
      return `Error optimizing prompt: ${err.message}`;
    }
  }

  if (!config?.apiKey) {
    return "Error: OpenAI API Key is missing in the configuration. Please run 'seepient setup' or check your .env file.";
  }

  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
  });

  try {
    const completion = await client.chat.completions.create({
      model: config.model || "gpt-4o",
      messages: [
        {
          role: "system",
          content: `You are an expert Prompt Engineer. Your goal is to rewrite the user's raw prompt to be clear, precise, and highly effective for LLMs or professional communication.

RULES:
1. Preserve the original intent.
2. Structure the prompt logically (e.g., Role, Context, Task, Constraints, Output Format).
3. Use professional and concise language.
4. Return ONLY the optimized prompt. Do not add conversational filler.`,
        },
        {
          role: "user",
          content: `Raw Prompt: "${rawPrompt}"\n\n${contextMsg}\n\nPlease optimize this prompt.`,
        },
      ],
    });

    return completion.choices[0].message?.content || "Error: Failed to generate optimized prompt.";
  } catch (error: any) {
    return `Error optimizing prompt: ${error.message}`;
  }
}
