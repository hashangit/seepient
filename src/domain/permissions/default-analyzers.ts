/**
 * Built-in analyzer registry + fallback — Domain (spec 027).
 *
 * The analyzer IMPLEMENTATIONS are full-package built-in-tool machinery
 * (registered via the foundation seam); this module carries the type, the
 * seam accessor, and the trusted-host fallback the consent pipeline uses for
 * tools without a dedicated analyzer.
 */
import type { PreparedToolAction } from "../../foundations/contracts/prepared-action.js";
import type { EffectRequest } from "../../foundations/contracts/tool-effects.js";
import type { ToolAnalysisContext } from "../../foundations/contracts/custom-tools.js";
import { digestArgs, digestAction } from "../../foundations/action-digest.js";
import { generateId } from "../../foundations/id.js";
import {
  getBuiltInAnalyzers,
  type ToolAnalyzer,
} from "../../foundations/injection-seams.js";

export type { ToolAnalyzer };

/** The registered built-in analyzers (empty in seepient-core). */
export function builtInAnalyzers(): Record<string, ToolAnalyzer> {
  return getBuiltInAnalyzers();
}

/**
 * Resolve the analyzer for a tool call; tools without a dedicated analyzer
 * fall back to a trusted-host prepared action (host callback + model egress).
 */
export function resolveAnalyzerWithFallback(
  analyzers: Record<string, ToolAnalyzer>,
  toolName: string,
): ToolAnalyzer {
  if (analyzers[toolName]) return analyzers[toolName];
  return async (args: unknown, ctx: ToolAnalysisContext): Promise<PreparedToolAction> => {
    const jsonArgs = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
    const operation = {
      kind: "trusted-host",
      registrationId: toolName,
      toolName,
      args: jsonArgs as any,
    } as const;
    const effects: EffectRequest[] = [
      { kind: "host-callback", toolName },
      {
        kind: "model-egress",
        providerClass: ctx.modelProviderClass,
        dataClasses: ["normal", "sensitive"],
        sources: [toolName],
      },
    ];
    const argsDigest = digestArgs(args);
    const actionDigest = digestAction({
      operation,
      effects,
      principalId: ctx.principalId,
      toolName,
      argsDigest,
      runId: ctx.runId,
      toolCallId: ctx.toolCallId,
    });
    return {
      version: 1,
      actionId: generateId(),
      runId: ctx.runId,
      toolCallId: ctx.toolCallId,
      toolName,
      principalId: ctx.principalId,
      argsDigest,
      actionDigest,
      risk: "destructive",
      effects,
      display: {
        title: toolName,
        summary: `Execute host callback ${toolName}`,
        canonicalTargets: [],
        effects: ["host-callback"],
      },
      operation,
    } as unknown as PreparedToolAction;
  };
}
