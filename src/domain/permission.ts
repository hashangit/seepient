/**
 * Permission Pre-Filter — risk-based tool approval matrix.
 *
 * Pure functions that determine whether a tool execution should be
 * auto-approved or require explicit approval, based on the tool's
 * risk category and the configured permission level.
 */

import type { PermissionLevel, ToolRiskCategory } from "../foundations/types.js";
import type { ToolModule } from "../foundations/contracts/tool.js";

// Decision matrix: for each (level, risk) pair, auto-approve or ask.
const PERMISSION_MATRIX: Record<PermissionLevel, Record<ToolRiskCategory, "auto" | "ask">> = {
  strict:      { safe: "auto", edit: "ask", communications: "ask", destructive: "ask" },
  moderate:    { safe: "auto", edit: "auto", communications: "auto", destructive: "ask" },
  permissive:  { safe: "auto", edit: "auto", communications: "auto", destructive: "auto" },
};

/**
 * Check whether a tool should be auto-approved or needs approval.
 * Falls back to safe defaults for unknown levels or risk categories.
 */
export function checkToolPermission(
  level: PermissionLevel,
  risk: ToolRiskCategory,
): "auto" | "ask" {
  // Default to strict for unknown levels
  const safeLevel: PermissionLevel = (PERMISSION_MATRIX[level]) ? level : "strict";
  // Default to destructive for unknown risk categories
  const safeRisk: ToolRiskCategory = (PERMISSION_MATRIX[safeLevel][risk]) ? risk : "destructive";
  return PERMISSION_MATRIX[safeLevel][safeRisk];
}

/**
 * Look up a tool's risk category by name from the tool module registry.
 * Returns "destructive" for unknown tools (safe default).
 */
export function getToolRiskCategory(
  toolName: string,
  toolModules: ToolModule[],
): ToolRiskCategory {
  const mod = toolModules.find(t => t.definition.function.name === toolName);
  return mod?.risk ?? "destructive";
}

/**
 * Resolve the effective permission level from multiple config sources.
 * Priority: flag > env var > config file > default.
 * Invalid values silently fall through to the next source.
 */
export function resolvePermissionLevel(
  flagLevel?: string,
  envVar?: string,
  configLevel?: string,
): PermissionLevel {
  const validLevels = new Set<PermissionLevel>(["strict", "moderate", "permissive"]);

  if (flagLevel && validLevels.has(flagLevel as PermissionLevel)) {
    return flagLevel as PermissionLevel;
  }
  if (envVar && validLevels.has(envVar as PermissionLevel)) {
    return envVar as PermissionLevel;
  }
  if (configLevel && validLevels.has(configLevel as PermissionLevel)) {
    return configLevel as PermissionLevel;
  }
  return "moderate";
}
