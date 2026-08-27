import { readdir } from 'fs/promises';
import { join, dirname } from 'path';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { parseFrontmatter } from './parser.js';
import { Skill } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export function getSkillPaths(cwd: string): string[] {
  const paths: string[] = [];

  // 1. Environment variable (highest priority, colon-separated)
  const envPath = process.env.SEEPIENT_SKILLS_PATH;
  if (envPath) {
    paths.push(...envPath.split(':').filter(p => p));
  }

  // 2. Project skills
  paths.push(join(cwd, '.seepient', 'skills'));

  // 3. Volume-mounted skills (Docker)
  paths.push('/mnt/skills');

  // 4. Global user skills (~/.seepient/skills)
  paths.push(join(homedir(), '.seepient', 'skills'));

  // 4b. Cross-agent user skills (~/.agents/skills) — the shared standard
  // location used by other agents; Seepient-native global skills win on
  // name collision.
  paths.push(join(homedir(), '.agents', 'skills'));

  // 5. Bundled skills (shipped with seepient)
  if (!process.env.SEEPIENT_NO_BUNDLED_SKILLS) {
    paths.push(join(__dirname, '..', '..', 'skills'));
  }

  return paths;
}

export async function discoverSkills(cwd: string): Promise<Skill[]> {
  const paths = getSkillPaths(cwd);
  const skills = new Map<string, Skill>();

  // Load in reverse priority order so higher priority overwrites
  for (const searchPath of [...paths].reverse()) {
    if (!existsSync(searchPath)) continue;

    try {
      const entries = await readdir(searchPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillFile = join(searchPath, entry.name, 'SKILL.md');
        if (!existsSync(skillFile)) continue;

        try {
          const skill = await parseFrontmatter(skillFile);
          skill.basePath = join(searchPath, entry.name);
          skill.source = searchPath;

          const existing = skills.get(skill.name);
          if (!existing || skill.priority >= existing.priority) {
            skills.set(skill.name, skill);
          }
        } catch (error: any) {
          console.warn(`Warning: Failed to load skill from ${skillFile}: ${error.message}`);
        }
      }
    } catch {
      // Directory not readable, skip silently
    }
  }

  return Array.from(skills.values());
}
