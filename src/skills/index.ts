export type { Skill, SkillFrontmatter, SkillMetadata, SkillRegistry, SkillModelConfig, TruncationResult } from './types.js';
export { parseSkillFile, parseFrontmatter } from './parser.js';
export { discoverSkills, getSkillPaths } from './loader.js';
export { DefaultSkillRegistry } from './registry.js';
export { parseInvocation, substituteArgs } from './args.js';
export type { ParsedArgs } from './args.js';
export { resolveReferences } from './resolver.js';
export { limitSkillBody, getSkillBodyLimits } from './types.js';

import { discoverSkills } from './loader.js';
import { DefaultSkillRegistry } from './registry.js';
import { SkillRegistry } from './types.js';

let registry: SkillRegistry | null = null;

export async function initializeSkillRegistry(cwd: string): Promise<SkillRegistry> {
  const skills = await discoverSkills(cwd);
  registry = new DefaultSkillRegistry(skills);

  if (process.env.SEEPIENT_SKILLS_DEBUG) {
    console.log(`[SKILLS] Loaded ${skills.length} skills`);
    for (const s of skills) {
      console.log(`[SKILLS]   - ${s.name} from ${s.source}`);
    }
  }

  return registry;
}

export function getSkillRegistry(): SkillRegistry | null {
  return registry;
}
