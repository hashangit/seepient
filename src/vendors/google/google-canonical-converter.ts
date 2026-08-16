import type { ImageRequest, ImageBlock } from "../../foundations/schemas/inference.js";

export interface GoogleImageRequestPayload {
  contents: any;
  config?: any;
}

function resolveImageBlockBase64(block?: ImageBlock): { data: string; mimeType: string } | undefined {
  if (!block) return undefined;
  if ("data" in block && typeof block.data === "string") {
    return { data: block.data, mimeType: block.mediaType || "image/png" };
  }
  return undefined;
}

/**
 * Translates product-level ImageRequest to Google Gemini generateContent payload.
 */
export function canonicalToGoogleImagePayload(
  req: ImageRequest,
): GoogleImageRequestPayload {
  const op = req.operation ?? "generate";

  if (op === "generate") {
    return {
      contents: req.prompt,
    };
  }

  const inputImg = resolveImageBlockBase64(req.inputImage);
  const parts: any[] = [{ text: req.prompt }];

  if (inputImg) {
    parts.push({
      inlineData: {
        mimeType: inputImg.mimeType,
        data: inputImg.data,
      },
    });
  }

  const maskImg = resolveImageBlockBase64(req.mask);
  if (maskImg) {
    parts.push({
      inlineData: {
        mimeType: maskImg.mimeType,
        data: maskImg.data,
      },
    });
  }

  return {
    contents: [{ role: "user", parts }],
  };
}
