/**
 * Skill sources composition helper (Spec 021-1).
 *
 * Re-exports from capabilities layer to preserve existing imports.
 */
export {
  resetMultiZeroSourcesNoticeForTest,
  emitMultiZeroSourcesNoticeOnce,
  computeEffectiveSkillSources,
} from "../../capabilities/skills/skill-sources-helper.js";
