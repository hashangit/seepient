import { Skill, SkillFrontmatter } from './types.js';

/**
 * Split a raw skill content string into YAML frontmatter and body.
 * Returns empty yaml and original content if frontmatter delimiters are absent or unclosed.
 */
export function splitFrontmatter(content: string): { yaml: string; body: string } {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith('---')) {
    return { yaml: '', body: content };
  }

  const endIdx = trimmed.indexOf('---', 3);
  if (endIdx === -1) {
    return { yaml: '', body: content };
  }

  const yaml = trimmed.slice(3, endIdx).trim();
  const body = trimmed.slice(endIdx + 3).trimStart();

  return { yaml, body };
}

/**
 * Parse a skill from raw content string.
 */
export function parseSkillContent(
  content: string,
  sourceLabel: string = "injected",
  filePath: string = "",
): Skill {
  const { frontmatter } = extractFrontmatter(content);

  if (!frontmatter.name) throw new Error(`Skill missing 'name' field`);
  if (!frontmatter.description) throw new Error(`Skill missing 'description' field`);

  return {
    name: frontmatter.name,
    description: frontmatter.description,
    version: frontmatter.version || '1.0.0',
    author: frontmatter.author,
    tags: frontmatter.tags || [],
    allowedTools: frontmatter.allowedTools,
    priority: frontmatter.priority || 0,
    basePath: '',
    source: sourceLabel,
    frontmatter,
    filePath,
  };
}

function extractFrontmatter(content: string): { frontmatter: SkillFrontmatter; body: string } {
  const { yaml, body } = splitFrontmatter(content);
  return { frontmatter: yaml ? parseYaml(yaml) : ({} as SkillFrontmatter), body };
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
