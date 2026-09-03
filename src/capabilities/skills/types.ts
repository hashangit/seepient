export type {
  SkillModelConfig,
  SkillFrontmatter,
  Skill,
  SkillMetadata,
  SkillRegistryContract as SkillRegistry,
} from "../../foundations/contracts/skill-registry.js";

import type { Skill } from "../../foundations/contracts/skill-registry.js";

/**
 * SkillSource signature seam placeholder for Spec 021-1.
 * Will be replaced in-place in Spec 021-1 by the canonical contract:
 * `list(): Promise<SkillRecord[]>`.
 */
export interface SkillSource {
  readonly id: string;
  readonly kind: string;
  load?(cwd: string): Promise<Skill[]>;
}

/** Default maximum skill body size in characters (~8k tokens at 4 chars/token). */
export const DEFAULT_SKILL_BODY_MAX_CHARS = 32_000;

/** Default warning threshold in characters (~2k tokens at 4 chars/token). */
export const DEFAULT_SKILL_BODY_WARN_CHARS = 8_000;

/**
 * Resolved skill body limits from environment variables.
 * Falls back to defaults if not set or unparsable.
 */
export function getSkillBodyLimits(): { maxChars: number; warnChars: number } {
  const maxChars = parseInt(process.env.SEEPIENT_SKILL_BODY_MAX_CHARS || '', 10);
  const warnChars = parseInt(process.env.SEEPIENT_SKILL_BODY_WARN_CHARS || '', 10);
  return {
    maxChars: Number.isFinite(maxChars) && maxChars > 0 ? maxChars : DEFAULT_SKILL_BODY_MAX_CHARS,
    warnChars: Number.isFinite(warnChars) && warnChars > 0 ? warnChars : DEFAULT_SKILL_BODY_WARN_CHARS,
  };
}

/** Result of applying skill body size limits. */
export interface TruncationResult {
  /** The (possibly truncated) body */
  body: string;
  /** Whether truncation was applied */
  truncated: boolean;
  /** Original body size in characters */
  originalChars: number;
  /** Estimated original token count (chars / 4) */
  originalTokenEstimate: number;
  /** Final body size in characters */
  finalChars: number;
  /** Estimated final token count (chars / 4) */
  finalTokenEstimate: number;
}

/**
 * Enforce size limits on a skill body.
 * Truncates with a clear marker if the body exceeds maxChars.
 * Fail-soft: never throws, always returns a usable body.
 */
export function limitSkillBody(
  body: string,
  maxChars?: number,
  warnChars?: number,
): TruncationResult {
  const limits = getSkillBodyLimits();
  const max = maxChars ?? limits.maxChars;
  const originalChars = body.length;
  const originalTokenEstimate = Math.ceil(originalChars / 4);

  if (originalChars <= max) {
    return {
      body,
      truncated: false,
      originalChars,
      originalTokenEstimate,
      finalChars: originalChars,
      finalTokenEstimate: originalTokenEstimate,
    };
  }

  const marker =
    `\n\n[... Skill body truncated: ${originalChars} chars total, ${max} shown. ` +
    `Reduce skill body size or set SEEPIENT_SKILL_BODY_MAX_CHARS to increase the limit. ...]`;

  const truncatedBody = body.slice(0, max - marker.length) + marker;
  const finalChars = truncatedBody.length;
  const finalTokenEstimate = Math.ceil(finalChars / 4);

  return {
    body: truncatedBody,
    truncated: true,
    originalChars,
    originalTokenEstimate,
    finalChars,
    finalTokenEstimate,
  };
}
