import type { ImageRequest, ImageBlock } from "../../foundations/schemas/inference.js";

export interface OpenAIImageParams {
  prompt: string;
  n?: number;
  size?: "256x256" | "512x512" | "1024x1024" | "1792x1024" | "1024x1792";
  quality?: "standard" | "hd";
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
  model = "dall-e-3",
): OpenAIImageParams {
  const isDallE3 = model.includes("dall-e-3");
  const quality = isDallE3 ? (req.qualityPreset === "high" ? "hd" : "standard") : undefined;

  let size: OpenAIImageParams["size"] = "1024x1024";
  if (isDallE3) {
    if (req.aspectRatio === "16:9") size = "1792x1024";
    else if (req.aspectRatio === "9:16") size = "1024x1792";
    else size = "1024x1024";
  } else {
    size = "1024x1024";
  }

  return {
    prompt: req.prompt,
    n: req.count ?? 1,
    quality,
    size,
    response_format: "b64_json",
    inputImageBuffer: resolveImageBlockBuffer(req.inputImage),
    maskBuffer: resolveImageBlockBuffer(req.mask),
  };
}
