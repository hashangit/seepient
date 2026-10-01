export type { Skill, SkillFrontmatter, SkillMetadata, SkillRegistry, SkillModelConfig, TruncationResult } from './types.js';
export type { SkillRecord, SkillSource, SkillStore, SkillLiteral } from '../../foundations/contracts/skill-source.js';
export { FsSkillSources } from './fs-skill-sources.js';
export { parseSkillContent, splitFrontmatter } from './parser.js';
export { DefaultSkillRegistry } from './registry.js';
export { parseInvocation, substituteArgs } from './args.js';
export type { ParsedArgs } from './args.js';
export { resolveReferences } from './resolver.js';
export { limitSkillBody, getSkillBodyLimits } from './types.js';

import { parseSkillContent } from './parser.js';
import { DefaultSkillRegistry } from './registry.js';
import { FsSkillSources } from './fs-skill-sources.js';
import type { Skill, SkillRegistry } from './types.js';
import type { SkillSource, SkillRecord } from '../../foundations/contracts/skill-source.js';

async function loadSkillsFromSources(
  sources: SkillSource[],
): Promise<{ skills: Skill[]; rawContentMap: Map<string, string> }> {
  const map = new Map<string, Skill>();
  const rawContentMap = new Map<string, string>();
  for (const src of sources) {
    const isFsSource = src instanceof FsSkillSources;
    let records: SkillRecord[];
    try {
      records = await src.list();
    } catch (err: any) {
      const label = (src as any)?.name ?? (src as any)?.constructor?.name ?? "injected";
      console.warn(
        `[SKILLS] Warning: Skill source "${label}" failed to load skills: ${err?.message ?? err}. Continuing with remaining sources.`,
      );
      continue;
    }
    for (const rec of records) {
      try {
        const parsed = parseSkillContent(rec.content, rec.source ?? "injected", rec.filePath ?? "");
        map.set(parsed.name, parsed);
        // FR-033: Content first, filePath fallback.
        // Injected sources materialize content in rawContentMap, even if filePath is present.
        // FsSkillSources defers bodies via filePath (lazy-loaded on getBody) and clears rawContentMap
        // so that an earlier shadowed record's content does not leak through (W240).
        if (isFsSource) {
          rawContentMap.delete(parsed.name);
        } else {
          rawContentMap.set(parsed.name, rec.content);
        }
      } catch (err: any) {
        console.warn(
          `[SKILLS] Warning: Failed to parse skill record "${rec.name ?? "unnamed"}": ${err?.message ?? err}`,
        );
      }
    }
  }
  return { skills: Array.from(map.values()), rawContentMap };
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

  // Unified tenancy-aware composition (FR-002):
  // Multi mode: injected sources only, ambient discovery is NEVER invoked
  // Single mode: fs is the built-in first source, composed with injected sources (last-wins)
  const effectiveSources: SkillSource[] = isMulti
    ? (options?.sources ?? [])
    : [new FsSkillSources(cwd), ...(options?.sources ?? [])];

  const { skills, rawContentMap } = await loadSkillsFromSources(effectiveSources);
  const registry = new DefaultSkillRegistry(skills, rawContentMap);

  if (process.env.SEEPIENT_SKILLS_DEBUG) {
    console.log(`[SKILLS] Loaded ${skills.length} skills`);
    for (const s of skills) {
      console.log(`[SKILLS]   - ${s.name} from ${s.source}`);
    }
  }

  return registry;
}
