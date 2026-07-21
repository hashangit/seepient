import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../hooks/use-theme.js';

// ── inline parsing: **bold**, *italics*, `code`, [text](url), ~~strike~~ ─
//
// Order in the alternation matters: **bold** must precede *italics*, or the
// single-star branch would greedily eat the inner pair. The `\S` guards on
// italics prevent `a * b * c` (math/spaced asterisks) from false-triggering.

type Inline = { kind: 'text' | 'bold' | 'italic' | 'strike' | 'code' | 'link'; text: string; url?: string };

const INLINE_RE = /\*\*(.+?)\*\*|\*(\S(?:[^*]*\S)?)\*|~~(.+?)~~|`(.+?)`|\[(.+?)\]\(([^)]+)\)/g;

function parseInline(text: string): Inline[] {
  const segments: Inline[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  INLINE_RE.lastIndex = 0;
  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > last) segments.push({ kind: 'text', text: text.slice(last, m.index) });
    if (m[1] !== undefined) segments.push({ kind: 'bold', text: m[1] });
    else if (m[2] !== undefined) segments.push({ kind: 'italic', text: m[2] });
    else if (m[3] !== undefined) segments.push({ kind: 'strike', text: m[3] });
    else if (m[4] !== undefined) segments.push({ kind: 'code', text: m[4] });
    else if (m[5] !== undefined) segments.push({ kind: 'link', text: m[5], url: m[6] });
    last = m.index + m[0].length;
  }
  if (last < text.length) segments.push({ kind: 'text', text: text.slice(last) });
  return segments;
}

function InlineText({ text }: { text: string }): React.ReactElement {
  const theme = useTheme();
  const segments = parseInline(text);
  return (
    <Text>
      {segments.map((s, i) => {
        if (s.kind === 'bold') return <Text key={i} bold>{s.text}</Text>;
        if (s.kind === 'italic') return <Text key={i} italic>{s.text}</Text>;
        if (s.kind === 'strike') return <Text key={i} strikethrough color={theme.fgDim}>{s.text}</Text>;
        if (s.kind === 'code') return <Text key={i} backgroundColor={theme.bgHighlight} color={theme.orange}>{s.text}</Text>;
        if (s.kind === 'link') return <Text key={i} color={theme.cyan} underline>{s.text}</Text>;
        return <Text key={i}>{s.text}</Text>;
      })}
    </Text>
  );
}

// ── block parsing ───────────────────────────────────────────────────────

type Block =
  | { type: 'code'; lines: string[] }
  | { type: 'heading'; level: number; text: string }
  | { type: 'list'; ordered: boolean; depth: number; text: string }
  | { type: 'table'; headers: string[]; rows: string[][] }
  | { type: 'paragraph'; text: string }
  | { type: 'spacer' };

// Leading-space to nesting-depth map: 0–1 spaces → 0, 2–3 → 1, 4–5 → 2, …
// Keeps two-space indentation as the canonical one-level step while
// tolerating a single trailing space.
function indentDepth(lead: string): number {
  return Math.floor(lead.length / 2);
}

function parseBlocks(content: string): Block[] {
  const lines = content.split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('```')) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) { code.push(lines[i]); i++; }
      i++; // closing fence
      blocks.push({ type: 'code', lines: code });
    } else if (/^#{1,6}\s/.test(line)) {
      const hashMatch = line.match(/^(#{1,6})\s+(.*)$/);
      blocks.push({ type: 'heading', level: hashMatch ? hashMatch[1].length : 1, text: hashMatch ? hashMatch[2] : line.replace(/^#{1,6}\s/, '') });
      i++;
    } else {
      // Bullet (`-`/`*`/`+`) or ordered (`1.`) list item, with leading
      // whitespace preserved as a nesting depth.
      const bullet = line.match(/^(\s*)([-*+])\s+(.*)$/);
      const ordered = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
      if (bullet) {
        blocks.push({ type: 'list', ordered: false, depth: indentDepth(bullet[1]), text: bullet[3] });
        i++;
      } else if (ordered) {
        blocks.push({ type: 'list', ordered: true, depth: indentDepth(ordered[1]), text: ordered[3] });
        i++;
      } else if (line.startsWith('|') && line.endsWith('|')) {
        // GFM table: collect header + separator + data rows
        const rows: string[][] = [];
        rows.push(parseTableRow(line));
        i++;
        if (i < lines.length && lines[i].match(/^\|[\s\-:]+\|$/)) {
          i++; // skip separator
          while (i < lines.length && lines[i].startsWith('|') && lines[i].endsWith('|')) {
            rows.push(parseTableRow(lines[i]));
            i++;
          }
        }
        const headers = rows[0];
        const dataRows = rows.slice(1);
        blocks.push({ type: 'table', headers, rows: dataRows });
      } else if (line.trim() === '') {
        // A blank line becomes a spacer only when it sits between two
        // content blocks — leading, trailing, and doubled blanks collapse
        // to nothing (or the single spacer already pushed). This is what
        // gives the rendered output its paragraph/section separation.
        if (blocks.length > 0 && blocks[blocks.length - 1].type !== 'spacer') {
          blocks.push({ type: 'spacer' });
        }
        i++;
      } else {
        blocks.push({ type: 'paragraph', text: line });
        i++;
      }
    }
  }
  return blocks;
}

function parseTableRow(line: string): string[] {
  return line.split('|').slice(1, -1).map((c) => c.trim());
}

/**
 * CommonMark-subset renderer for assistant messages: code fences (language
 * tag ignored), inline code, **bold**, *italics*, ~~strikethrough~~,
 * [links](url) (underlined), `-`/`*`/`+` bullets, `1.` ordered lists with
 * two-space nesting, `#`–`######` headings (level 1–2 bold purple, 3+ dim),
 * and GFM tables. Hand-rolled — no `marked` dependency.
 */
export function Markdown({ content }: { content: string }): React.ReactElement {
  const theme = useTheme();
  const blocks = parseBlocks(content);

  // Ordered-list numbering state: consecutive `1.` items at the same depth
  // count up; any other block (or a depth change) resets to 1. The parser
  // flattens each item into its own block, so the counter lives here.
  let ordDepth = -1;
  let ordNum = 0;

  return (
    <Box flexDirection="column">
      {blocks.map((b, i) => {
        // Ordered-list numbering: count up across consecutive ordered items
        // at the same depth; any other block ends the run so the next `1.`
        // sequence restarts from 1 (per CommonMark). Computed up front so the
        // reset runs for every block type, before any early return below.
        let ordMarker = '';
        if (b.type === 'list' && b.ordered) {
          if (b.depth !== ordDepth) { ordDepth = b.depth; ordNum = 1; } else { ordNum++; }
          ordMarker = `${ordNum}. `;
        } else {
          ordDepth = -1;
        }

        if (b.type === 'code') {
          return (
            <Box key={i} flexDirection="column" borderStyle="round" borderColor={theme.fgGutter} paddingLeft={1} paddingRight={1}>
              {b.lines.map((l, j) => (
                <Text key={j} color={theme.fgDim}>{l || ' '}</Text>
              ))}
            </Box>
          );
        }
        if (b.type === 'spacer') {
          return <Text key={i}> </Text>;
        }
        if (b.type === 'heading') {
          // Level 1–2 read as section headings; 3+ defers visually so a
          // reply's section/subsection hierarchy is legible at a glance.
          const major = b.level <= 2;
          return (
            <Text key={i} bold color={major ? theme.purple : theme.fgDim} underline={b.level === 1}>
              <InlineText text={b.text} />
            </Text>
          );
        }
        if (b.type === 'list') {
          const marker = b.ordered ? ordMarker : '• ';
          return (
            <Box key={i} paddingLeft={b.depth * 2}>
              <Text color={b.ordered ? theme.yellow : theme.green}>{marker}</Text>
              <InlineText text={b.text} />
            </Box>
          );
        }
        if (b.type === 'table') {
          const colWidths = b.headers.map((h, ci) => {
            const vals = [h.length, ...b.rows.map((r) => (r[ci] ?? '').length)];
            return Math.max(...vals) + 2;
          });
          return (
            <Box key={i} flexDirection="column">
              <Box>
                {b.headers.map((h, ci) => (
                  <Box key={ci} width={colWidths[ci]}>
                    <Text bold>{h}</Text>
                  </Box>
                ))}
              </Box>
              {b.rows.map((row, ri) => (
                <Box key={ri}>
                  {b.headers.map((_, ci) => (
                    <Box key={ci} width={colWidths[ci]}>
                      <Text color={theme.fgDim}>{row[ci] ?? ''}</Text>
                    </Box>
                  ))}
                </Box>
              ))}
            </Box>
          );
        }
        return <Text key={i}><InlineText text={b.text} /></Text>;
      })}
    </Box>
  );
}
