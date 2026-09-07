export type { Skill, SkillFrontmatter, SkillMetadata, SkillRegistry, SkillModelConfig, TruncationResult } from './types.js';
export type { SkillRecord, SkillSource, SkillStore, SkillLiteral } from '../../foundations/contracts/skill-source.js';
export { parseSkillFile, parseFrontmatter, parseSkillContent } from './parser.js';
export { discoverSkills, getSkillPaths } from './loader.js';
export { DefaultSkillRegistry } from './registry.js';
export { parseInvocation, substituteArgs } from './args.js';
export type { ParsedArgs } from './args.js';
export { resolveReferences } from './resolver.js';
export { limitSkillBody, getSkillBodyLimits } from './types.js';

import { discoverSkills } from './loader.js';
import { parseSkillContent } from './parser.js';
import { DefaultSkillRegistry } from './registry.js';
import type { Skill, SkillRegistry } from './types.js';
import type { SkillSource } from '../../foundations/contracts/skill-source.js';

async function loadSkillsFromSources(cwd: string, sources: SkillSource[]): Promise<Skill[]> {
  const map = new Map<string, Skill>();
  for (const src of sources) {
    const records = await src.list();
    for (const rec of records) {
      const parsed = parseSkillContent(rec.content, rec.source ?? "injected");
      map.set(parsed.name, parsed);
    }
  }
  return Array.from(map.values());
}

/**
 * Initialize a skill registry for the given workspace cwd.
 *
 * @param cwd Active workspace directory
 * @param options.sources Extensible skill sources (Spec 021-1 / Spec 022)
 * @param options.tenancyMode Active tenancy mode ("single" | "multi")
 */
export async function initializeSkillRegistry(
  cwd: string,
  options?: { sources?: SkillSource[]; tenancyMode?: "single" | "multi" },
): Promise<SkillRegistry> {
  const isMulti = options?.tenancyMode === "multi";
  let skills: Skill[] = [];

  if (isMulti) {
    // Multi-tenant mode: only injected sources are used; ambient discovery is NEVER invoked
    if (options?.sources && options.sources.length > 0) {
      skills = await loadSkillsFromSources(cwd, options.sources);
    }
  } else if (options?.sources && options.sources.length > 0) {
    // Single-mode with sources: ambient discovery + sources (sources win on collision)
    const ambientSkills = await discoverSkills(cwd);
    const sourceSkills = await loadSkillsFromSources(cwd, options.sources);
    const map = new Map<string, Skill>();
    for (const s of ambientSkills) map.set(s.name, s);
    for (const s of sourceSkills) map.set(s.name, s);
    skills = Array.from(map.values());
  } else {
    // Single-mode default: ambient discovery
    skills = await discoverSkills(cwd);
  }

  const registry = new DefaultSkillRegistry(skills);

  if (process.env.SEEPIENT_SKILLS_DEBUG) {
    console.log(`[SKILLS] Loaded ${skills.length} skills`);
    for (const s of skills) {
      console.log(`[SKILLS]   - ${s.name} from ${s.source}`);
    }
  }

  return registry;
}
