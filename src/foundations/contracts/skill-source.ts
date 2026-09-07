/**
 * SkillSource, SkillStore, and related contracts — Foundations (Spec 021-1).
 *
 * String-only and self-contained: no parsed types leak into the contract,
 * and nothing in foundations imports upward.
 */

export interface SkillRecord {
  name: string;
  content: string;
  source?: string;
  filePath?: string;
}

export interface SkillLiteral {
  name: string;
  content: string;
}

export interface SkillSource {
  list(): SkillRecord[] | Promise<SkillRecord[]>;
}

export interface SkillStore extends SkillSource {
  save(record: SkillRecord): Promise<void>;
}
