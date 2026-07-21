import type { SkillMetadata } from '../../foundations/types.js';

/**
 * Build a skill catalog string suitable for appending to the system prompt.
 * Returns an empty string when no skills are available.
 */
export function buildSkillCatalog(metadata: SkillMetadata[]): string {
  if (metadata.length === 0) return '';

  const lines = metadata.map(s => {
    const tags = s.tags.length > 0 ? ` [${s.tags.join(', ')}]` : '';
    return `- ${s.name}: ${s.description}${tags}`;
  });

  return [
    'AVAILABLE SKILLS (activate with use_skill tool):',
    ...lines,
    'When a user request matches a skill, call use_skill with the skill name.',
  ].join('\n');
}
