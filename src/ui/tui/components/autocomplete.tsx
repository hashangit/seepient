import { Box, Text } from 'ink';
import { useTheme } from '../hooks/use-theme.js';

export interface Suggestion {
  name: string;
  description?: string;
}

/** Subsequence check — do query's chars appear in order within text? */
function isSubsequence(text: string, query: string): boolean {
  if (!query) return true;
  let qi = 0;
  for (let i = 0; i < text.length && qi < query.length; i++) {
    if (text[i] === query[qi]) qi++;
  }
  return qi === query.length;
}

function basename(name: string): string {
  const slash = name.lastIndexOf('/');
  return slash === -1 ? name : name.slice(slash + 1);
}

/**
 * Relevance score for `name` against `query` (higher = better; -1 = no match).
 * Contiguous matches in the basename dominate so `@read` ranks README over a
 * file that merely has r…e scattered in its path. Falls back to subsequence.
 */
function scoreSuggestion(name: string, query: string): number {
  if (!query) return 0;
  const q = query.toLowerCase();
  const full = name.toLowerCase();
  const base = basename(name).toLowerCase();
  if (!isSubsequence(full, q)) return -1;
  let score = 0;
  if (base.startsWith(q)) score += 100;
  else if (base.includes(q)) score += 60;
  else if (full.includes(q)) score += 30;
  else score += 5; // subsequence only — weakest
  score -= name.split('/').length; // shallower paths rank higher
  if (base.startsWith('.')) score -= 15; // hidden / artifacts sink
  return score;
}

/** Filter to matches and rank by relevance score (desc). */
export function fuzzyFilter(items: Suggestion[], query: string): Suggestion[] {
  return items
    .map((s) => ({ s, score: scoreSuggestion(s.name, query) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.s);
}

const MAX_VISIBLE = 8;

/**
 * Fuzzy suggestion dropdown rendered above the prompt. Caller owns selection
 * state and key handling (Tab/arrows/Esc in `prompt-area`); this is pure view.
 *
 * The list is windowed: only MAX_VISIBLE rows render, and the window follows
 * `selectedIndex` (clamped) so ↑/↓ scroll through every match — not just the
 * first page. Count hints show how many are hidden above/below.
 */
export function Autocomplete({
  suggestions,
  selectedIndex,
  prefix,
}: {
  suggestions: Suggestion[];
  selectedIndex: number;
  prefix: '/' | '@';
}) {
  const theme = useTheme();
  if (suggestions.length === 0) return null;
  const half = Math.floor(MAX_VISIBLE / 2);
  const start = Math.max(0, Math.min(selectedIndex - half, suggestions.length - MAX_VISIBLE));
  const visible = suggestions.slice(start, start + MAX_VISIBLE);
  const end = start + visible.length;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.fgGutter} paddingLeft={1} paddingRight={1}>
      {start > 0 ? (
        <Text color={theme.fgDim}>  ↑ {start} more</Text>
      ) : null}
      {visible.map((s, i) => {
        const selected = start + i === selectedIndex;
        return (
          <Box key={s.name}>
            <Text
              backgroundColor={selected ? theme.blue : undefined}
              color={selected ? theme.bg : theme.green}
            >
              {selected ? '▶ ' : '  '}
              {prefix}
              {s.name}
            </Text>
            {s.description ? (
              <Text color={theme.fgDim}> {s.description.split('\n')[0].slice(0, 50)}</Text>
            ) : null}
          </Box>
        );
      })}
      {end < suggestions.length ? (
        <Text color={theme.fgDim}>  ↓ {suggestions.length - end} more</Text>
      ) : null}
    </Box>
  );
}
