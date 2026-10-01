/**
 * FsSkillSources — Built-in filesystem skill source (Spec 021-1).
 *
 * Implements SkillSource over the five filesystem discovery layers,
 * surfacing raw file contents via loader discovery.
 */
import type { SkillSource, SkillRecord } from '../../foundations/contracts/skill-source.js';
import { discoverSkillRecords } from './loader.js';

export class FsSkillSources implements SkillSource {
  constructor(private readonly cwd: string) {}

  async list(): Promise<SkillRecord[]> {
    return discoverSkillRecords(this.cwd);
  }
}
