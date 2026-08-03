/**
 * S0 spike — per model × per-operation image matrix (spec 010, S0.12 — Rev 4.3 S5).
 *
 * Fills `contracts/inference-adapter.md §6` with TESTED results for the Google
 * rows of the matrix. Each cell runs the real operation against the named model
 * and records whether it succeeded, errored with "unsupported", or errored otherwise.
 *
 * Operations: generate / variation / edit / mask.
 *   - Gemini flash-image models (3.1 family current, 2.5 legacy) generate via
 *     `models.generateContent` with `config.responseModalities: ["IMAGE"]` (and
 *     "TEXT" so the model can narrate). Edit/variation/mask pass an input image
 *     plus an operation-specific prompt; mask operations name the target region.
 *
 * Image presence is decided by inspecting the typed response
 * `candidates[].content.parts[].inlineData` (mimeType image/* + non-empty data),
 * NOT by stringifying the response.
 *
 * Every live call is gated on `GOOGLE_API_KEY`; without it, the matrix SKIPS
 * with a clear message. Operator runs with the key exported to fill the matrix
 * cells, then pastes results into inference-adapter.md §6 + research.md.
 */
import { describe, it, expect } from "vitest";
import { GoogleGenAI, Modality } from "@google/genai";
import { env, requireKey, SPIKE_KEYS } from "../../__tests__/spike-keys.js";

/** One tested cell of the image matrix. */
interface MatrixCell {
  provider: string;
  model: string;
  operation: "generate" | "variation" | "edit" | "mask";
  result: "supported" | "unsupported" | "error";
  detail?: string;
}

/**
 * A small but VISIBLE 8×8 PNG: a solid red square on a white background. Visible
 * content (not transparent) is required so edit/variation/mask operations have
 * recognisable subject matter, and so a mask prompt can name a region ("the red
 * square") and assert the rest stays white. Base64 of a hand-encoded PNG.
 */
const VISIBLE_RED_SQUARE_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAW0lEQVR42mP8z8DwHwAFBQwAXYjqDgB8//4DAOYAxP+vAADGP4zffwAxAKrGFyAA5r+fA8T/vwGY/zQA5v8j/r9AAPyPBQA1 iP0DzP8ZAPH/lwH8TwAAwBQXG6Y6yJ0AAAAASUVORK5CYII=".replace(/\s/g, "");

/** Does a generateContent response carry at least one image part? */
function hasImagePart(res: { candidates?: { content?: { parts?: { inlineData?: { mimeType?: string; data?: string } }[] } }[] }): boolean {
  return !!res.candidates?.some((c) =>
    c.content?.parts?.some((p) => {
      const mime = p.inlineData?.mimeType ?? "";
      return mime.startsWith("image/") && !!p.inlineData?.data;
    }),
  );
}

/** Per-operation prompt. Mask names the target region explicitly. */
function promptFor(op: MatrixCell["operation"]): string {
  switch (op) {
    case "generate": return "Generate a small image of a blue circle on a white background.";
    case "variation": return "Produce a variation of the provided image.";
    case "edit": return "Edit the provided image: change the red square to green.";
    case "mask": return "Edit ONLY the red square (top-left region of the image); leave the surrounding white background unchanged. Recolour the red square to blue.";
  }
}

/** Run ONE (model, operation) cell and return the observed result. */
async function runCell(ai: GoogleGenAI, model: string, operation: MatrixCell["operation"], inputB64: string): Promise<MatrixCell> {
  try {
    if (operation === "generate") {
      const res = await ai.models.generateContent({
        model,
        contents: promptFor(operation),
        config: { responseModalities: [Modality.IMAGE, Modality.TEXT] },
      });
      return { provider: "google", model, operation, result: hasImagePart(res) ? "supported" : "unsupported" };
    }
    // variation/edit/mask all require an input image
    const res = await ai.models.generateContent({
      model,
      contents: [{ role: "user", parts: [
        { text: promptFor(operation) },
        { inlineData: { mimeType: "image/png", data: inputB64 } },
      ] }],
      config: { responseModalities: [Modality.IMAGE, Modality.TEXT] },
    });
    return { provider: "google", model, operation, result: hasImagePart(res) ? "supported" : "unsupported" };
  } catch (err) {
    const msg = String(err);
    if (/not supported|unsupported|does not support/i.test(msg)) {
      return { provider: "google", model, operation, result: "unsupported", detail: msg.slice(0, 200) };
    }
    return { provider: "google", model, operation, result: "error", detail: msg.slice(0, 200) };
  }
}

const GEMINI_IMAGE_MODELS = ["gemini-3.1-flash-image", "gemini-2.5-flash-image"] as const;
const OPERATIONS = ["generate", "variation", "edit", "mask"] as const;

describe("S0.12 Google image matrix (Gemini flash-image)", () => {
  const key = env(SPIKE_KEYS.google);

  it.skipIf(!key)("fills the Google image matrix rows when GOOGLE_API_KEY is set", async (ctx) => {
    requireKey(ctx, SPIKE_KEYS.google, key);
    const ai = new GoogleGenAI({ apiKey: key });
    const cells: MatrixCell[] = [];
    for (const model of GEMINI_IMAGE_MODELS) {
      for (const op of OPERATIONS) {
        cells.push(await runCell(ai, model, op, VISIBLE_RED_SQUARE_PNG_B64));
      }
    }
    // Record the matrix for the operator to paste into inference-adapter.md §6.
    // eslint-disable-next-line no-console
    console.log("S0.12 Google image matrix results:\n" +
      cells.map((c) => `  ${c.model.padEnd(24)} ${c.operation.padEnd(10)} = ${c.result}${c.detail ? ` (${c.detail})` : ""}`).join("\n"));
    expect(cells.length, "all matrix cells ran").toBe(GEMINI_IMAGE_MODELS.length * OPERATIONS.length);
    expect(cells.every((c) => ["supported", "unsupported", "error"].includes(c.result))).toBe(true);
  }, 120_000);
});
