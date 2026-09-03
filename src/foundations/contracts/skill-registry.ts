/**
 * Skill registry interface and types — Foundations (Spec 021).
 *
 * Defines the strongly-typed contract for SkillRegistry and skill metadata,
 * avoiding upward layer dependencies from Foundations to Capabilities.
 */

export interface SkillModelConfig {
  provider?: string;
  model: string;
}

export interface SkillFrontmatter {
  name: string;
  description: string;
  version?: string;
  author?: string;
  tags?: string[];
  allowedTools?: string[];
  priority?: number;
  args?: string[];
  model?: SkillModelConfig;
}

export interface Skill {
  name: string;
  description: string;
  version: string;
  author?: string;
  tags: string[];
  allowedTools?: string[];
  priority: number;
  basePath: string;
  source: string;
  frontmatter: SkillFrontmatter;
  filePath: string;
}

export interface SkillMetadata {
  name: string;
  description: string;
  version: string;
  tags: string[];
  allowedTools?: string[];
}

export interface SkillRegistryContract {
  get(name: string): Skill | undefined;
  getAll(): Skill[];
  getMetadata(): SkillMetadata[];
  getBody(name: string): Promise<string | undefined>;
}
