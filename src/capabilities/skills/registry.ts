import { readFile } from 'fs/promises';
import { Skill, SkillMetadata, SkillRegistry } from './types.js';
import { splitFrontmatter } from './parser.js';

export class DefaultSkillRegistry implements SkillRegistry {
  private skills: Map<string, Skill>;
  private bodyCache: Map<string, string>;
  private rawContentMap: Map<string, string>;
  private readonly maxCacheSize = 5;

  constructor(skills: Skill[], rawContentMap?: Map<string, string>) {
    this.skills = new Map(skills.map(s => [s.name, s]));
    this.bodyCache = new Map();
    this.rawContentMap = rawContentMap ?? new Map();
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

    // Check raw content map first (injected sources, inline literals)
    const raw = this.rawContentMap.get(name);
    if (raw !== undefined) {
      const { body } = splitFrontmatter(raw);
      if (body !== undefined) {
        this.setCache(name, body);
        return body;
      }
    }

    // Load body lazily from disk if filePath is present
    if (skill.filePath) {
      try {
        const content = await readFile(skill.filePath, 'utf-8');
        const { body } = splitFrontmatter(content);
        if (body !== undefined) {
          this.setCache(name, body);
          return body;
        }
      } catch {
        // File deleted, moved, or unreadable
      }
    }

    return undefined;
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
