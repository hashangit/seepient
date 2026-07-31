import * as fs from 'fs';
import * as path from 'path';

// Dirs we never want in `@file` completion (deps, build output, VCS, caches).
const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage',
  '.next', '.cache', '.turbo', '.verdaccio', 'tmp',
]);
const MAX_FILES = 5000;

/**
 * Recursively list project files as relative posix paths, skipping dependency
 * / build / VCS directories. Pure (no cache): the caller (`prompt-area`) owns
 * the result in React state and refreshes it on each idle mount and whenever
 * `@` is entered — so files an agent created during a run show up immediately
 * on the next prompt, with no restart.
 */
export function getFileIndex(root: string = process.cwd()): string[] {
  const files: string[] = [];
  const stack = [root];
  while (stack.length > 0 && files.length < MAX_FILES) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (IGNORED_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        stack.push(path.join(dir, e.name));
      } else if (e.isFile()) {
        files.push(path.relative(root, path.join(dir, e.name)).split(path.sep).join('/'));
      }
    }
  }
  files.sort();
  return files;
}
