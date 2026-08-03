/**
 * S0 spike — OpenAI-direct image matrix (spec 010, S0.12 — Rev 4.3 S5).
 *
 * Fills the OpenAI rows of `contracts/inference-adapter.md §6`:
 *   - `dall-e-3`: generate only (edit/variation/mask unsupported)
 *   - `gpt-image-2`: generate / variation / edit / mask
 *
 * Uses the OpenAI SDK directly (via the vendor quarantine `src/vendors/openai.ts`),
 * the same surface the P3 OpenAI raw wrapper will build on. Each cell records
 * supported / unsupported / error.
 *
 * `dall-e-3` is generation-only; its edit/variation/mask cells are asserted
 * unsupported directly (the API rejects them) rather than skipped. `gpt-image-2`
 * runs all four operations.
 *
 * Gated on `OPENAI_API_KEY`; skips without it.
 */
import { describe, it, expect } from "vitest";
import { OpenAI } from "../../openai.js";
import { env, requireKey, SPIKE_KEYS } from "../../__tests__/spike-keys.js";

type Operation = "generate" | "variation" | "edit" | "mask";

interface MatrixCell {
  provider: string;
  model: string;
  operation: Operation;
  result: "supported" | "unsupported" | "error";
  detail?: string;
}

/** Visible 8×8 red square on white, base64 PNG. */
const VISIBLE_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAW0lEQVR42mP8z8DwHwAFBQwAXYjqDgB8//4DAOYAxP+vAADGP4zffwAxAKrGFyAA5r+fA8T/vwGY/zQA5v8j/r9AAPyPBQA1iP0DzP8ZAPH/lwH8TwAAwBQXG6Y6yJ0AAAAASUVORK5CYII=";

/** Decode the fixture PNG to an Uploadable File for the OpenAI SDK. */
function pngFile(): File {
  const bytes = Buffer.from(VISIBLE_PNG_B64, "base64");
  return new File([bytes], "input.png", { type: "image/png" });
}

async function runCell(client: OpenAI, model: string, operation: Operation): Promise<MatrixCell> {
  const cell = (result: MatrixCell["result"], detail?: string): MatrixCell => ({ provider: "openai", model, operation, result, detail });
  try {
    if (operation === "generate") {
      const res = await client.images.generate({ model, prompt: "A blue circle on a white background", n: 1, size: "1024x1024" });
      return cell(res.data?.length ? "supported" : "unsupported");
    }
    if (operation === "variation") {
      const res = await client.images.createVariation({ model, image: pngFile(), n: 1 });
      return cell(res.data?.length ? "supported" : "unsupported");
    }
    if (operation === "edit") {
      const res = await client.images.edit({ model, prompt: "Change the red square to green", image: pngFile(), n: 1 });
      return cell(res.data?.length ? "supported" : "unsupported");
    }
    // mask: edit with an explicit mask image naming the editable region.
    const res = await client.images.edit({ model, prompt: "Recolour the red region to blue", image: pngFile(), mask: pngFile(), n: 1 });
    return cell(res.data?.length ? "supported" : "unsupported");
  } catch (err) {
    const msg = String(err);
    if (/unsupported|does not support|invalid|not available|model_not_found|invalid_request/i.test(msg)) {
      return cell("unsupported", msg.slice(0, 200));
    }
    return cell("error", msg.slice(0, 200));
  }
}

const MODELS = ["dall-e-3", "gpt-image-2"] as const;
const OPERATIONS: Operation[] = ["generate", "variation", "edit", "mask"];

describe("S0.12 OpenAI-direct image matrix (dall-e-3 + gpt-image-2)", () => {
  const key = env(SPIKE_KEYS.openai);

  it.skipIf(!key)("fills the OpenAI image matrix rows when OPENAI_API_KEY is set", async (ctx) => {
    requireKey(ctx, SPIKE_KEYS.openai, key);
    const client = new OpenAI({ apiKey: key });
    const cells: MatrixCell[] = [];
    for (const model of MODELS) {
      for (const op of OPERATIONS) {
        cells.push(await runCell(client, model, op));
      }
    }
    // eslint-disable-next-line no-console
    console.log("S0.12 OpenAI image matrix results:\n" +
      cells.map((c) => `  ${c.model.padEnd(12)} ${c.operation.padEnd(10)} = ${c.result}${c.detail ? ` (${c.detail})` : ""}`).join("\n"));
    expect(cells.length, "all matrix cells ran").toBe(MODELS.length * OPERATIONS.length);
    // dall-e-3 is generation-only: its variation/edit/mask cells MUST be unsupported.
    const dalleNongen = cells.filter((c) => c.model === "dall-e-3" && c.operation !== "generate");
    expect(dalleNongen.every((c) => c.result === "unsupported"), "dall-e-3 supports only generate").toBe(true);
    // The dall-e-3 generate cell should be supported (assuming key has image access).
    const dalleGen = cells.find((c) => c.model === "dall-e-3" && c.operation === "generate");
    expect(dalleGen?.result, "dall-e-3 generate supported").toBe("supported");
  }, 180_000);
});
