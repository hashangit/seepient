import * as fs from "node:fs";
import type {
  ImageBackend,
  InferenceTarget,
  InferenceOptions,
} from "../../../foundations/contracts/backend-ports.js";
import type {
  ImageRequest,
  ImageResult,
} from "../../../foundations/schemas/inference.js";
import { generateImages } from "../../media/media.js";
import { InferenceError } from "../../../foundations/errors.js";

/**
 * Legacy media adapter implementing ImageBackend using OpenAI image APIs.
 */
export class LegacyMediaAdapter implements ImageBackend {
  async generate(
    target: InferenceTarget,
    req: ImageRequest,
    _opts?: InferenceOptions,
  ): Promise<ImageResult> {
    const lease = target.credential.acquireLease();
    try {
      const secret = await lease.secret();

      if (target.upstreamProvider !== "openai" && target.upstreamProvider !== "openai-compatible") {
        throw new InferenceError({
          code: "unsupported_capability",
          message: `Legacy media adapter does not support upstream provider "${target.upstreamProvider}"`,
          providerAccount: target.providerAccount,
          model: target.model,
          retryable: false,
        });
      }

      const legacyMode =
        req.operation === "generate"
          ? "text-to-image"
          : req.operation === "variation"
            ? "variation"
            : req.operation === "edit" || req.operation === "mask"
              ? "edit"
              : undefined;

      const legacyResult = await generateImages(
        {
          prompt: req.prompt,
          imagePath: req.inputImage,
          maskPath: req.mask,
          mode: legacyMode,
          model: target.model,
          n: req.count ?? 1,
          quality: req.qualityPreset === "hd" ? "hd" : "standard",
          style: req.style,
          outputDir: req.outputDir,
        },
        {
          apiKey: secret,
          baseUrl: target.baseUrl,
        },
      );

      if (typeof legacyResult === "string" && legacyResult.startsWith("Error")) {
        throw new InferenceError({
          code: "invalid_request",
          message: legacyResult,
          providerAccount: target.providerAccount,
          model: target.model,
          retryable: false,
        });
      }

      // Parse output: media.ts returns "Successfully generated N image(s):\n<path1>\n<path2>"
      const rawLines = typeof legacyResult === "string"
        ? legacyResult.split("\n").map((l) => l.trim()).filter((l) => l.length > 0)
        : [];

      // Filter out header lines (e.g. "Successfully generated N image(s):")
      const candidatePaths = rawLines.filter(
        (line) => !line.toLowerCase().startsWith("successfully generated"),
      );

      const images = candidatePaths.map((item) => {
        if (item.startsWith("http://") || item.startsWith("https://")) {
          return {
            mimeType: "image/png",
            url: item,
          };
        }
        try {
          if (fs.existsSync(item)) {
            const buffer = fs.readFileSync(item);
            return {
              mimeType: "image/png",
              base64: buffer.toString("base64"),
            };
          }
        } catch {
          // Fall through to path string if reading file fails
        }
        return {
          mimeType: "image/png",
          url: item.includes("://") ? item : undefined,
          base64: !item.includes("://") ? item : undefined,
        };
      });

      // Ensure at least one image entry if no file paths were parsed
      if (images.length === 0) {
        images.push({
          mimeType: "image/png",
          url: typeof legacyResult === "string" && legacyResult.startsWith("http") ? legacyResult : undefined,
          base64: typeof legacyResult === "string" && !legacyResult.startsWith("http") && !legacyResult.startsWith("Successfully")
            ? legacyResult
            : undefined,
        });
      }

      return { images };
    } finally {
      await lease.release();
    }
  }
}
