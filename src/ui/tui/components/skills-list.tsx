import { Box, Text, useStdout } from 'ink';
import { useTheme } from '../hooks/use-theme.js';

export interface SkillsListProps {
  skills: Array<{ name: string; description: string }>;
}

/**
 * Display form of a kebab-case skill name: capitalize the first letter of each
 * segment. Mirrors `titleCaseSkill` in the command registry so the two paths
 * agree on casing.
 */
function titleCase(name: string): string {
  return name
    .split('-')
    .map((seg) => (seg.length === 0 ? seg : seg[0].toUpperCase() + seg.slice(1)))
    .join('-');
}

/**
 * Bordered skills listing rendered for the `/skills` command. Matches the
 * CommandPalette / HelpDialog idiom: rounded green border, bold title,
 * capitalized name column, dim wrapped description. Display-only — invocation
 * names stay lowercase.
 */
export function SkillsList({ skills }: SkillsListProps) {
  const theme = useTheme();
  const { stdout } = useStdout();
  const columns = stdout?.columns ?? 80;

  // Name column width = widest display name, capped at 24.
  const nameWidth = Math.min(24, Math.max(...skills.map((s) => titleCase(s.name).length), 8));

  // Reserve name column + separators; wrap the description into the rest.
  const descWidth = Math.max(20, columns - nameWidth - 6 /* border(2) + pad(2) + gap(2) */);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.green} paddingLeft={1} paddingRight={1}>
      <Text color={theme.green} bold>Skills</Text>
      {skills.map((s) => {
        const name = titleCase(s.name);
        // Soft-wrap long descriptions at word boundaries to `descWidth`.
        const wrapped = wrapWords(s.description, descWidth);
        return (
          <Box key={s.name} flexDirection="column" marginTop={1}>
            <Box>
              <Text color={theme.green} bold>{name.padEnd(nameWidth)}</Text>
              <Text color={theme.fgDim}>  {wrapped[0]}</Text>
            </Box>
            {wrapped.slice(1).map((line, i) => (
              <Box key={i}>
                <Text>{' '.repeat(nameWidth)}  </Text>
                <Text color={theme.fgDim}>{line}</Text>
              </Box>
            ))}
          </Box>
        );
      })}
      <Box marginTop={1}>
        <Text color={theme.fgDim}>Use </Text>
        <Text color={theme.cyan}>/&lt;skill-name&gt;</Text>
        <Text color={theme.fgDim}> &lt;query&gt; to invoke a skill directly.</Text>
      </Box>
    </Box>
  );
}

/** Greedy word-wrap at `width`, preserving word boundaries. */
function wrapWords(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [''];
  const lines: string[] = [];
  let current = words[0];
  for (let i = 1; i < words.length; i++) {
    if (current.length + 1 + words[i].length <= width) {
      current += ' ' + words[i];
    } else {
      lines.push(current);
      current = words[i];
    }
  }
  lines.push(current);
  return lines;
}
