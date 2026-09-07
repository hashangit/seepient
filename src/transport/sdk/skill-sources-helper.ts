/**
 * Skill sources composition helper (Spec 021-1).
 *
 * Appends inline SkillLiterals as a synthetic "inline" SkillSource
 * after user-supplied sources.
 */
import type { SkillSource, SkillLiteral } from "../../foundations/contracts/skill-source.js";

export function computeEffectiveSkillSources(
  sources?: SkillSource[],
  skills?: string[] | boolean | SkillLiteral[],
): SkillSource[] {
  const effective: SkillSource[] = sources ? [...sources] : [];
  if (Array.isArray(skills)) {
    const literals = skills.filter(
      (s): s is SkillLiteral =>
        typeof s === "object" && s !== null && "content" in s && typeof (s as any).name === "string",
    );
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
