/**
 * use-feed — owns the feed array.
 *
 * Entries are appended immutably (so completed history can render via Ink's
 * `<Static>` without re-rendering) and updated by id (streaming/permission
 * state). `appendEntry` generates and returns the entry id so callers can
 * patch the same entry later (e.g. resolve a permission prompt).
 */

import { useCallback, useState } from 'react';
import { generateId } from '../../../../core/message-convert.js';
import type { FeedEntry, FeedEntryInput, BlockEntry } from '../types.js';

export interface FeedApi {
  entries: FeedEntry[];
  appendEntry: (entry: FeedEntryInput) => string;
  updateEntry: (id: string, patch: Partial<FeedEntry>) => void;
  clear: () => void;
  /** T4-1 — Extend an entry's props (narrower than updateEntry, for blocks). */
  updateBlockEntry: (id: string, patch: Partial<BlockEntry>) => void;
}

export function useFeed(): FeedApi {
  const [entries, setEntries] = useState<FeedEntry[]>([]);

  const appendEntry = useCallback((entry: FeedEntryInput): string => {
    const id = generateId();
    setEntries((prev) => [...prev, { ...entry, id } as FeedEntry]);
    return id;
  }, []);

  const updateEntry = useCallback((id: string, patch: Partial<FeedEntry>): void => {
    setEntries((prev) => prev.map((e) => (e.id === id ? ({ ...e, ...patch } as FeedEntry) : e)));
  }, []);

  const clear = useCallback((): void => {
    setEntries([]);
  }, []);

  const updateBlockEntry = useCallback((id: string, patch: Partial<BlockEntry>): void => {
    setEntries((prev) => prev.map((e) => (e.id === id ? ({ ...e, ...patch } as FeedEntry) : e)));
  }, []);

  return { entries, appendEntry, updateEntry, clear, updateBlockEntry };
}
