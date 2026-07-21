import { readFile } from 'fs/promises';
import { Skill, SkillFrontmatter, getSkillBodyLimits } from './types.js';

export async function parseSkillFile(filePath: string): Promise<Skill> {
  const content = await readFile(filePath, 'utf-8');
  const { frontmatter, body } = extractFrontmatter(content);

  if (!frontmatter.name) throw new Error(`Skill missing 'name' field: ${filePath}`);
  if (!frontmatter.description) throw new Error(`Skill missing 'description' field: ${filePath}`);

  // Warn at load time if body exceeds the soft warning threshold
  const { warnChars } = getSkillBodyLimits();
  if (body.length > warnChars) {
    console.warn(
      `[SKILLS] Warning: Skill "${frontmatter.name}" body is ${body.length} chars ` +
      `(~${Math.ceil(body.length / 4)} tokens). Consider trimming below ${warnChars} chars ` +
      `for optimal context usage.`
    );
  }

  return {
    name: frontmatter.name,
    description: frontmatter.description,
    version: frontmatter.version || '1.0.0',
    author: frontmatter.author,
    tags: frontmatter.tags || [],
    allowedTools: frontmatter.allowedTools,
    priority: frontmatter.priority || 0,
    basePath: '',
    source: '',
    frontmatter,
    filePath,
  };
}

/**
 * Parse only the YAML frontmatter from a skill file.
 * Discards the body text immediately — body is loaded lazily via getBody().
 */
export async function parseFrontmatter(filePath: string): Promise<Skill> {
  const content = await readFile(filePath, 'utf-8');
  const frontmatter = extractFrontmatterOnly(content);

  if (!frontmatter.name) throw new Error(`Skill missing 'name' field: ${filePath}`);
  if (!frontmatter.description) throw new Error(`Skill missing 'description' field: ${filePath}`);

  return {
    name: frontmatter.name,
    description: frontmatter.description,
    version: frontmatter.version || '1.0.0',
    author: frontmatter.author,
    tags: frontmatter.tags || [],
    allowedTools: frontmatter.allowedTools,
    priority: frontmatter.priority || 0,
    basePath: '',
    source: '',
    frontmatter,
    filePath,
  };
}

function extractFrontmatter(content: string): { frontmatter: SkillFrontmatter; body: string } {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith('---')) {
    return { frontmatter: {} as SkillFrontmatter, body: content };
  }

  const endIdx = trimmed.indexOf('---', 3);
  if (endIdx === -1) {
    return { frontmatter: {} as SkillFrontmatter, body: content };
  }

  const yaml = trimmed.slice(3, endIdx);
  const body = trimmed.slice(endIdx + 3).trimStart();

  return { frontmatter: parseYaml(yaml), body };
}

/**
 * Extract only the frontmatter from a skill file.
 * The body text is not returned — used during discovery to avoid holding bodies in memory.
 */
function extractFrontmatterOnly(content: string): SkillFrontmatter {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith('---')) {
    return {} as SkillFrontmatter;
  }

  const endIdx = trimmed.indexOf('---', 3);
  if (endIdx === -1) {
    return {} as SkillFrontmatter;
  }

  const yaml = trimmed.slice(3, endIdx);
  return parseYaml(yaml);
}

function parseYaml(yaml: string): SkillFrontmatter {
  const result: Record<string, unknown> = {};
  const lines = yaml.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Dash-based array item (skip — consumed by parent key)
    if (/^\s+-\s/.test(line)) { i++; continue; }

    const match = line.match(/^(\w+):\s*(.*)/);
    if (!match) { i++; continue; }

    const [, key, rawValue] = match;
    const val = rawValue.trim();

    // Multiline literal (|) or folded (>)
    if (val === '|' || val === '>') {
      const multiline: string[] = [];
      i++;
      while (i < lines.length && (lines[i].startsWith('  ') || lines[i] === '')) {
        multiline.push(lines[i].replace(/^  /, ''));
        i++;
      }
      result[key] = multiline.join('\n').trim();
      continue;
    }

    // Empty value — check if next lines are dash-based array items
    if (val === '') {
      const arr: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const arrMatch = lines[j].match(/^\s+-\s+(.*)/);
        if (!arrMatch) break;
        arr.push(arrMatch[1].trim().replace(/^['"]|['"]$/g, ''));
        j++;
      }
      if (arr.length > 0) {
        result[key] = arr;
        i = j;
        continue;
      }
    }

    // Inline array [a, b, c]
    if (val.startsWith('[') && val.endsWith(']')) {
      result[key] = val
        .slice(1, -1)
        .split(',')
        .map(s => s.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean);
      i++;
      continue;
    }

    // Number
    if (/^\d+(\.\d+)?$/.test(val)) {
      result[key] = Number(val);
      i++;
      continue;
    }

    // String (strip surrounding quotes)
    result[key] = val.replace(/^['"]|['"]$/g, '');
    i++;
  }

  return result as unknown as SkillFrontmatter;
}
