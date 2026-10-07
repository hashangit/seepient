/**
 * Tool-analyzer contract — Foundations (spec 027: type moved out of the
 * full-side analyzers barrel so the domain consent pipeline can reference it
 * without importing a full-package module).
 */
import type { PreparedToolAction } from "./prepared-action.js";
import type { ToolAnalysisContext } from "./custom-tools.js";

/**
 * Analyzer signature: maps tool args + analysis context to a prepared action.
 */
export type ToolAnalyzer = (
  args: unknown,
  ctx: ToolAnalysisContext,
) => Promise<PreparedToolAction>;
