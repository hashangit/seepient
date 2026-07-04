/**
 * @path file reference resolver for skills and chat.
 *
 * Supported patterns:
 * - @path/to/file         — relative to project root (process.cwd())
 * - @seepient_documents/file — resolves to ~/seepient_documents/file
 * - @~/path/to/file       — explicit home directory path
 *
 * Resolution flow:
 * 1. Scan text for @reference patterns
 * 2. Resolve each path
 * 3. Read file content
 * 4. Replace @reference with inlined content
 */

import { readFile } from 'fs/promises';
import { resolve, join } from 'path';
import { existsSync, statSync } from 'fs';
import { homedir } from 'os';

const MAX_FILE_SIZE = 1024 * 1024; // 1MB per file
const MAX_REFERENCES = 10; // Max @references per input
const MAX_TOTAL_RESOLVED_SIZE = 2 * 1024 * 1024; // 2MB total across all inlined files

/**
 * Extract all @reference patterns from text.
 * Matches @path/to/file, @seepient_documents/foo, @~/foo/bar
 * Does NOT match email addresses (requires word boundary before @)
 */
function extractReferences(text: string): string[] {
  // Match @path patterns but exclude email addresses
  // Pattern: @ followed by a path-like string (no spaces, starts with alphanumeric or ~ or seepient_documents)
  const pattern = /(?:^|[^a-zA-Z0-9])@(~?\/?[a-zA-Z0-9_][a-zA-Z0-9_./-]*)/g;
  const matches: string[] = [];
  let match;

  while ((match = pattern.exec(text)) !== null) {
    matches.push(match[1]); // The path part without @
  }

  return matches.slice(0, MAX_REFERENCES);
}

/**
 * Resolve a reference path to an absolute file path.
 */
function resolveReference(refPath: string, projectRoot: string): string {
  // @~/... → explicit home directory
  if (refPath.startsWith('~/')) {
    return resolve(join(homedir(), refPath.slice(2)));
  }

  // @seepient_documents/... → ~/seepient_documents/...
  if (refPath.startsWith('seepient_documents/') || refPath === 'seepient_documents') {
    return resolve(join(homedir(), refPath));
  }

  // @path/to/file → relative to project root
  return resolve(join(projectRoot, refPath));
}

/**
 * Validate a resolved path is within allowed boundaries.
 * Prevents path traversal attacks.
 */
function isPathAllowed(resolvedPath: string, projectRoot: string): boolean {
  const home = homedir();
  const allowedPrefixes = [
    projectRoot,                    // Project files (read-only via @)
    join(home, 'seepient_documents'),  // Agent workspace
    join(home, '.seepient'),           // Config/skills
  ];

  return allowedPrefixes.some(prefix => resolvedPath.startsWith(prefix));
}

/**
 * Resolve all @path references in a text string, inlining file contents.
 * Returns the text with references replaced by file contents.
 */
export async function resolveReferences(text: string, projectRoot?: string): Promise<string> {
  const root = projectRoot || process.cwd();
  const refs = extractReferences(text);

  if (refs.length === 0) return text;

  let result = text;
  let cumulativeSize = 0;

  for (const ref of refs) {
    const resolvedPath = resolveReference(ref, root);

    // Security check
    if (!isPathAllowed(resolvedPath, root)) {
      result = result.replace(`@${ref}`, `[Error: Access denied — path outside allowed boundaries: @${ref}]`);
      continue;
    }

    // Existence check
    if (!existsSync(resolvedPath)) {
      result = result.replace(`@${ref}`, `[Error: File not found: @${ref}]`);
      continue;
    }

    try {
      const stat = statSync(resolvedPath);
      if (stat.size > MAX_FILE_SIZE) {
        result = result.replace(`@${ref}`, `[Error: File too large (${Math.round(stat.size / 1024)}KB exceeds 1MB limit): @${ref}]`);
        continue;
      }

      const content = await readFile(resolvedPath, 'utf-8');

      // Cumulative size cap — stop inlining if total exceeds budget
      if (cumulativeSize + content.length > MAX_TOTAL_RESOLVED_SIZE) {
        result = result.replace(`@${ref}`, `[Skipped: cumulative resolved size would exceed ${Math.round(MAX_TOTAL_RESOLVED_SIZE / 1024)}KB limit]: @${ref}]`);
        continue;
      }
      cumulativeSize += content.length;

      const ext = resolvedPath.split('.').pop() || '';
      const langMap: Record<string, string> = {
        ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
        py: 'python', rs: 'rust', go: 'go', json: 'json', yaml: 'yaml', yml: 'yaml',
        md: 'markdown', html: 'html', css: 'css', sh: 'bash', sql: 'sql',
      };
      const lang = langMap[ext] || ext;

      result = result.replace(`@${ref}`, `\n---\n**File: ${ref}**\n\`\`\`${lang}\n${content}\n\`\`\`\n---\n`);
    } catch (error: any) {
      result = result.replace(`@${ref}`, `[Error: Failed to read @${ref}: ${error.message}]`);
    }
  }

  return result;
}
