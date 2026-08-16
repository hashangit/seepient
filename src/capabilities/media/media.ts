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
}

async function downloadImage(url: string, destPath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download image: ${response.statusText}`);
  const buffer = await response.arrayBuffer();
  fs.writeFileSync(destPath, Buffer.from(buffer));
}

export interface StructuredImageResult {
  success: boolean;
  files: string[];
  error?: string;
}

export async function generateImagesStructured(
  req: ImageRequest,
  config: MediaConfig,
): Promise<StructuredImageResult> {
  const apiKey = config.imageApiKey || config.apiKey || process.env.OPENAI_API_KEY;
  const baseURL = config.imageBaseUrl || config.baseUrl || process.env.OPENAI_COMPAT_BASE_URL || process.env.OPENAI_BASE_URL;

  if (!apiKey) {
    return {
      success: false,
      files: [],
      error: "Error: Image Service API Key is missing. Please configure it in .seepient/setting.json (imageApiKey or apiKey).",
    };
  }

  const client = new OpenAI({
    apiKey: apiKey,
    baseURL: baseURL,
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
          const response = await client.images.generate({
            model: "dall-e-3",
            prompt: prompt,
            n: 1,
            size: size as any,
            quality: quality as any,
            style: style as any,
            response_format: "url",
          });

          const imageUrl = response.data?.[0]?.url;
          if (imageUrl) {
            const fileName = `generated-${Date.now()}-${i + 1}.png`;
            const filePath = path.join(resolvedOutputDir, fileName);
            await downloadImage(imageUrl, filePath);
            generatedFiles.push(filePath);
          }
        }
      } else {
        const response = await client.images.generate({
          model: model,
          prompt: prompt,
          n: n,
          size: size as any,
          response_format: "url",
        });

        const data = response.data || [];
        for (let i = 0; i < data.length; i++) {
          const imageUrl = data[i].url;
          if (imageUrl) {
            const fileName = `generated-${Date.now()}-${i + 1}.png`;
            const filePath = path.join(resolvedOutputDir, fileName);
            await downloadImage(imageUrl, filePath);
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

      const response = await client.images.createVariation({
        image: fs.createReadStream(imagePath),
        n: n,
        model: "dall-e-2",
        size: size as any,
        response_format: "url",
      });

      const data = response.data || [];
      for (let i = 0; i < data.length; i++) {
        const imageUrl = data[i].url;
        if (imageUrl) {
          const fileName = `variation-${Date.now()}-${i + 1}.png`;
          const filePath = path.join(resolvedOutputDir, fileName);
          await downloadImage(imageUrl, filePath);
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

      const response = await client.images.edit(params);

      const data = response.data || [];
      for (let i = 0; i < data.length; i++) {
        const imageUrl = data[i].url;
        if (imageUrl) {
          const fileName = `edited-${Date.now()}-${i + 1}.png`;
          const filePath = path.join(resolvedOutputDir, fileName);
          await downloadImage(imageUrl, filePath);
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
    return {
      success: false,
      files: [],
      error: `Error generating image: ${error.message}`,
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
  if (!config?.apiKey) {
    return "Error: OpenAI API Key is missing in the configuration. Please run 'seepient setup' or check your .env file.";
  }

  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl
  });

  const contextMsg = context ? `Context: ${context}` : "Context: General AI Assistant interaction.";

  try {
    const completion = await client.chat.completions.create({
      model: config.model || 'gpt-4o',
      messages: [
        {
          role: "system",
          content: `You are an expert Prompt Engineer. Your goal is to rewrite the user's raw prompt to be clear, precise, and highly effective for LLMs or professional communication.

RULES:
1. Preserve the original intent.
2. Structure the prompt logically (e.g., Role, Context, Task, Constraints, Output Format).
3. Use professional and concise language.
4. Return ONLY the optimized prompt. Do not add conversational filler.`
        },
        {
          role: "user",
          content: `Raw Prompt: "${rawPrompt}"

${contextMsg}

Please optimize this prompt.`
        }
      ]
    });

    return completion.choices[0].message?.content || "Error: Failed to generate optimized prompt.";
  } catch (error: any) {
    return `Error optimizing prompt: ${error.message}`;
  }
}
