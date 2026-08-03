/**
 * S0 spike — per model × per-operation image matrix (spec 010, S0.12 — Rev 4.3 S5).
 *
 * Fills `contracts/inference-adapter.md §6` with TESTED results for the Google
 * rows of the matrix. Each cell runs the real operation against the named model
 * and records whether it succeeded, errored with "unsupported", or errored otherwise.
 *
 * Operations: generate / variation / edit / mask.
 *   - Gemini flash-image models (3.1 family current, 2.5 legacy) generate via
 *     `models.generateContent`; edit/variation/mask use `models.generateContent`
 *     with an input image (where supported).
 *
 * Every live call is gated on `GOOGLE_API_KEY`; without it, the matrix SKIPS
 * with a clear message. Operator runs with the key exported to fill the matrix
 * cells, then pastes results into inference-adapter.md §6 + research.md.
 */
import { describe, it, expect } from "vitest";
import { GoogleGenAI } from "@google/genai";
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
 * Run ONE (model, operation) cell and return the observed result.
 * Google's Gemini image models take prompts + optional inline images via
 * generateContent; the operation is expressed through the request shape.
 */
async function runCell(
  ai: GoogleGenAI,
  model: string,
  operation: MatrixCell["operation"],
  samplePngBase64: string,
): Promise<MatrixCell> {
  try {
    if (operation === "generate") {
      const res = await ai.models.generateContent({
        model,
        contents: "Generate a small image of a blue circle on white background.",
      });
      const hasImage = JSON.stringify(res).includes("inlineData") || JSON.stringify(res).includes("image");
      return { provider: "google", model, operation, result: hasImage ? "supported" : "unsupported", detail: "generateContent returned" };
    }
    // variation/edit/mask all require an input image
    const res = await ai.models.generateContent({
      model,
      contents: [
        { role: "user", parts: [
          { text: operation === "variation" ? "Give a variation of this image." : `Edit this image (op=${operation}).` },
          { inlineData: { mimeType: "image/png", data: samplePngBase64 } },
        ] },
      ],
    });
    const hasImage = JSON.stringify(res).includes("inlineData") || JSON.stringify(res).includes("image");
    return { provider: "google", model, operation, result: hasImage ? "supported" : "unsupported" };
  } catch (err) {
    const msg = String(err);
    if (/not supported|unsupported|does not support/i.test(msg)) {
      return { provider: "google", model, operation, result: "unsupported", detail: msg.slice(0, 200) };
    }
    return { provider: "google", model, operation, result: "error", detail: msg.slice(0, 200) };
  }
}

/** Tiny 8×8 transparent PNG (base64) for variation/edit/mask inputs. */
const SAMPLE_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX///8AAABVwtN+AAAAAXRSTlMAQObYZgAAABNJREFUCNdj+M+ABf+H4f9H8P9H8QEKwAcBAKYXvFwAAAAASUVORK5CYII=";

const GEMINI_IMAGE_MODELS = ["gemini-3.1-flash-image", "gemini-2.5-flash-image"] as const;
const OPERATIONS = ["generate", "variation", "edit", "mask"] as const;

describe("S0.12 Google image matrix (Gemini flash-image)", () => {
  const key = env(SPIKE_KEYS.google);

  it.skipIf(!key)("fills the Google image matrix rows when GOOGLE_API_KEY is set", async () => {
    requireKey({} as never, SPIKE_KEYS.google, key); // double-gate (skipIf already handles)
    const ai = new GoogleGenAI({ apiKey: key });
    const cells: MatrixCell[] = [];
    for (const model of GEMINI_IMAGE_MODELS) {
      for (const op of OPERATIONS) {
        cells.push(await runCell(ai, model, op, SAMPLE_PNG_B64));
      }
    }
    // Record the matrix for the operator to paste into inference-adapter.md §6.
    // eslint-disable-next-line no-console
    console.log("S0.12 Google image matrix results:\n" +
      cells.map((c) => `  ${c.model.padEnd(24)} ${c.operation.padEnd(10)} = ${c.result}${c.detail ? ` (${c.detail})` : ""}`).join("\n"));
    // The spike only asserts the matrix RAN (every cell produced a result); the
    // operator records supported/unsupported into the contract.
    expect(cells.length, "all matrix cells ran").toBe(GEMINI_IMAGE_MODELS.length * OPERATIONS.length);
    expect(cells.every((c) => ["supported", "unsupported", "error"].includes(c.result))).toBe(true);
  }, 120_000);
});
