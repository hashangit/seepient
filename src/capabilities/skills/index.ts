export type { Skill, SkillFrontmatter, SkillMetadata, SkillRegistry, SkillModelConfig, TruncationResult, SkillSource } from './types.js';
export { parseSkillFile, parseFrontmatter } from './parser.js';
export { discoverSkills, getSkillPaths } from './loader.js';
export { DefaultSkillRegistry } from './registry.js';
export { parseInvocation, substituteArgs } from './args.js';
export type { ParsedArgs } from './args.js';
export { resolveReferences } from './resolver.js';
export { limitSkillBody, getSkillBodyLimits } from './types.js';

import { discoverSkills } from './loader.js';
import { DefaultSkillRegistry } from './registry.js';
import type { SkillRegistry, SkillSource } from './types.js';

/**
 * Initialize a skill registry for the given workspace cwd.
 *
 * @param cwd Active workspace directory
 * @param options.sources Extensible skill sources (Spec 021-1 signature seam; placeholder for 021-1 implementation)
 */
export async function initializeSkillRegistry(
  cwd: string,
  options?: { sources?: SkillSource[] },
): Promise<SkillRegistry> {
  const skills = await discoverSkills(cwd);
  const registry = new DefaultSkillRegistry(skills);

  if (process.env.SEEPIENT_SKILLS_DEBUG) {
    console.log(`[SKILLS] Loaded ${skills.length} skills`);
    for (const s of skills) {
      console.log(`[SKILLS]   - ${s.name} from ${s.source}`);
    }
  }

  return registry;
}
