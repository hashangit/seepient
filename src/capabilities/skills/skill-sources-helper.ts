/**
 * Skill sources composition helper (Spec 021-1).
 *
 * Appends inline SkillLiterals as a synthetic "inline" SkillSource
 * after user-supplied sources.
 */
import type { SkillSource, SkillLiteral } from "../../foundations/contracts/skill-source.js";

let multiZeroSourcesNoticed = false;

export function resetMultiZeroSourcesNoticeForTest(): void {
  multiZeroSourcesNoticed = false;
}

export function emitMultiZeroSourcesNoticeOnce(): void {
  if (!multiZeroSourcesNoticed) {
    multiZeroSourcesNoticed = true;
    console.warn(
      `[SKILLS] Notice: Multi-tenant mode running with zero skill sources; ambient filesystem discovery is disabled.`,
    );
  }
}

export function computeEffectiveSkillSources(
  sources?: SkillSource[],
  skills?: string[] | boolean | SkillLiteral[],
): SkillSource[] {
  const effective: SkillSource[] = sources ? [...sources] : [];
  if (Array.isArray(skills)) {
    const literals: SkillLiteral[] = [];
    for (const s of skills) {
      if (typeof s === "object" && s !== null) {
        const name = (s as any).name;
        const content = (s as any).content;
        if (typeof name === "string" && name.trim().length > 0 && typeof content === "string") {
          literals.push(s as SkillLiteral);
        } else {
          console.warn(
            `[SKILLS] Warning: Malformed inline skill literal "${name ?? "unnamed"}": missing name or content string. Skipping.`,
          );
        }
      }
    }
    if (literals.length > 0) {
      effective.push({
        list: () =>
          literals.map((l) => ({
            name: l.name,
            content: l.content,
            source: "inline",
          })),
      });
    }
  }
  return effective;
}
