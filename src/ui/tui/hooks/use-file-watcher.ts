import { useEffect, useState, useCallback } from 'react';
import * as fs from 'fs';

const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.cache']);

/**
 * Watches the project directory for external file changes (using built-in
 * `fs.watch` with recursive mode — supported on macOS/Windows). Fires only
 * when the agent is idle (not running) so the agent's own writes don't
 * trigger false notifications. Debounced (fs.watch fires multiple events).
 */
export function useFileWatcher(idle: boolean): { changedFile: string | null; clear: () => void } {
  const [changedFile, setChangedFile] = useState<string | null>(null);

  useEffect(() => {
    if (!idle) return; // only watch when idle (agent's writes suppressed)
    let timer: ReturnType<typeof setTimeout> | null = null;
    let watcher: fs.FSWatcher | null = null;
    try {
      watcher = fs.watch(process.cwd(), { recursive: true }, (_eventType, filename) => {
        if (!filename) return;
        const parts = filename.split(/[/\\]/);
        if (parts.some((p) => IGNORED_DIRS.has(p) || p.startsWith('.'))) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          setChangedFile(filename);
          timer = null;
        }, 600);
      });
    } catch {
      // recursive watch not supported (Linux) — no-op.
    }
    return () => {
      watcher?.close();
      if (timer) clearTimeout(timer);
    };
  }, [idle]);

  const clear = useCallback((): void => setChangedFile(null), []);
  return { changedFile, clear };
}
