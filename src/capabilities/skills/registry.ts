import { readFile } from 'fs/promises';
import { Skill, SkillMetadata, SkillRegistry } from './types.js';

export class DefaultSkillRegistry implements SkillRegistry {
  private skills: Map<string, Skill>;
  private bodyCache: Map<string, string>;
  private readonly maxCacheSize = 5;

  constructor(skills: Skill[]) {
    this.skills = new Map(skills.map(s => [s.name, s]));
    this.bodyCache = new Map();
  }

  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  getAll(): Skill[] {
    return Array.from(this.skills.values());
  }

  getMetadata(): SkillMetadata[] {
    return this.getAll().map(s => ({
      name: s.name,
      description: s.description,
      version: s.version,
      tags: s.tags,
      allowedTools: s.allowedTools,
    }));
  }

  async getBody(name: string): Promise<string | undefined> {
    const skill = this.get(name);
    if (!skill) return undefined;

    // Check cache first
    const cached = this.bodyCache.get(name);
    if (cached !== undefined) return cached;

    // Load body lazily from disk
    try {
      const content = await readFile(skill.filePath, 'utf-8');
      const body = extractBody(content);
      if (body === undefined) return undefined;

      this.setCache(name, body);
      return body;
    } catch {
      // File deleted, moved, or unreadable
      return undefined;
    }
  }

  private setCache(name: string, body: string): void {
    this.bodyCache.delete(name); // Remove if exists (moves to end)
    this.bodyCache.set(name, body);

    // Evict oldest
    if (this.bodyCache.size > this.maxCacheSize) {
      const firstKey = this.bodyCache.keys().next().value as string;
      if (firstKey) this.bodyCache.delete(firstKey);
    }
  }

  getNames(): string[] {
    return Array.from(this.skills.keys());
  }
}

/**
 * Extract the body text after the closing --- delimiter of YAML frontmatter.
 */
function extractBody(content: string): string | undefined {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith('---')) {
    return content;
  }

  const endIdx = trimmed.indexOf('---', 3);
  if (endIdx === -1) {
    return undefined;
  }

  return trimmed.slice(endIdx + 3).trimStart() || undefined;
}
