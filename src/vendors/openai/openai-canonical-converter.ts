import type { ImageRequest, ImageBlock } from "../../foundations/schemas/inference.js";

export interface OpenAIImageParams {
  prompt: string;
  n?: number;
  size?: "256x256" | "512x512" | "1024x1024" | "1792x1024" | "1024x1792" | "1536x1024" | "1024x1536" | string;
  quality?: "standard" | "hd" | "high" | "medium" | "low" | "auto";
  style?: "vivid" | "natural";
  response_format?: "b64_json" | "url";
  inputImageBuffer?: Buffer;
  maskBuffer?: Buffer;
}

function resolveImageBlockBuffer(block?: ImageBlock): Buffer | undefined {
  if (!block) return undefined;
  if ("data" in block && typeof block.data === "string") {
    return Buffer.from(block.data, "base64");
  }
  return undefined;
}

/**
 * Translates product-level ImageRequest to OpenAI Images API parameters.
 */
export function canonicalToOpenAIImageParams(
  req: ImageRequest,
  model = "gpt-image-2",
): OpenAIImageParams {
  const isDallE3 = model.includes("dall-e-3");
  const isGptImage = model.includes("gpt-image");

  let quality: OpenAIImageParams["quality"];
  if (isDallE3) {
    quality = req.qualityPreset === "high" ? "hd" : "standard";
  } else if (isGptImage) {
    quality = req.qualityPreset === "high" ? "high" : (req.qualityPreset === "low" ? "low" : "medium");
  }

  let size: OpenAIImageParams["size"] = "1024x1024";
  if (isDallE3) {
    if (req.aspectRatio === "16:9") size = "1792x1024";
    else if (req.aspectRatio === "9:16") size = "1024x1792";
    else size = "1024x1024";
  } else if (isGptImage) {
    if (req.aspectRatio === "16:9" || req.aspectRatio === "3:2" || req.aspectRatio === "4:3" || req.aspectRatio === "5:4") {
      size = "1536x1024";
    } else if (req.aspectRatio === "9:16" || req.aspectRatio === "2:3" || req.aspectRatio === "3:4" || req.aspectRatio === "4:5") {
      size = "1024x1536";
    } else {
      size = "1024x1024";
    }
  } else {
    size = "1024x1024";
  }

  return {
    prompt: req.prompt,
    n: isDallE3 ? 1 : (req.count ?? 1),
    quality,
    size,
    response_format: "b64_json",
    inputImageBuffer: resolveImageBlockBuffer(req.inputImage),
    maskBuffer: resolveImageBlockBuffer(req.mask),
  };
}
