import type { ImageRequest, ImageBlock } from "../../foundations/schemas/inference.js";

export interface OpenAIImageParams {
  prompt: string;
  n?: number;
  size?: "256x256" | "512x512" | "1024x1024" | "1792x1024" | "1024x1792";
  quality?: "standard" | "hd";
  style?: "vivid" | "natural";
  response_format?: "url" | "b64_json";
  inputImagePath?: string;
  maskPath?: string;
}

function resolveImageBlockRef(block?: ImageBlock): string | undefined {
  if (!block) return undefined;
  if ("url" in block && typeof block.url === "string") return block.url;
  if ("artifact" in block && typeof block.artifact === "object" && block.artifact !== null) {
    return block.artifact.ref;
  }
  return undefined;
}

/**
 * Translates product-level ImageRequest to OpenAI Images API parameters.
 */
export function canonicalToOpenAIImageParams(req: ImageRequest): OpenAIImageParams {
  const quality = req.qualityPreset === "high" ? "hd" : "standard";

  let size: OpenAIImageParams["size"] = "1024x1024";
  if (req.aspectRatio === "16:9") size = "1792x1024";
  if (req.aspectRatio === "9:16") size = "1024x1792";

  return {
    prompt: req.prompt,
    n: req.count ?? 1,
    quality,
    size,
    response_format: "b64_json",
    inputImagePath: resolveImageBlockRef(req.inputImage),
    maskPath: resolveImageBlockRef(req.mask),
  };
}
