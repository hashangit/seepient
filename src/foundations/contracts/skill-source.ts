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
  /**
   * Optional path on disk.
   * By contract (FR-033), within a record, content is the body and filePath is
   * the fallback. A record carrying both fields resolves from content, so an
   * unreadable or remote filePath never yields an unloadable catalog entry.
   */
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
