/**
 * Dynamic argument parsing and template substitution for skills.
 *
 * Supports:
 * - $1, $2, ... — positional arguments
 * - $ALL — all arguments as a single string
 * - $COUNT — number of arguments
 * - $FIRST — first argument
 * - $LAST — last argument
 */

export interface ParsedArgs {
  positional: string[];
  raw: string;
}

/**
 * Parse a user input string into a skill name and arguments.
 * Handles quoted strings for multi-word arguments.
 *
 * @example
 * parseInvocation('/docker-ops build myapp:1.2.0 --no-cache')
 * // => { skillName: 'docker-ops', args: { positional: ['build', 'myapp:1.2.0', '--no-cache'], raw: 'build myapp:1.2.0 --no-cache' } }
 */
export function parseInvocation(input: string): { skillName: string; args: ParsedArgs } | null {
  if (!input.startsWith('/') || input.length < 2) return null;

  const body = input.slice(1);
  const firstSpace = body.search(/\s/);

  if (firstSpace === -1) {
    return { skillName: body, args: { positional: [], raw: '' } };
  }

  const skillName = body.slice(0, firstSpace);
  const argsRaw = body.slice(firstSpace + 1).trim();

  return {
    skillName,
    args: {
      positional: splitArgs(argsRaw),
      raw: argsRaw,
    },
  };
}

/**
 * Split argument string respecting quoted strings.
 */
function splitArgs(input: string): string[] {
  const args: string[] = [];
  let current = '';
  let inQuote = false;
  let quoteChar = '';

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (inQuote) {
      if (ch === quoteChar) {
        inQuote = false;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = true;
      quoteChar = ch;
    } else if (ch === ' ') {
      if (current) {
        args.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }

  if (current) args.push(current);
  return args;
}

/**
 * Substitute template variables in a skill body with actual arguments.
 *
 * Supported variables:
 * - $1, $2, ..., $N — positional arguments (1-indexed)
 * - $ALL — all arguments joined as a string
 * - $COUNT — number of arguments
 * - $FIRST — first argument (same as $1)
 * - $LAST — last argument
 */
export function substituteArgs(body: string, args: ParsedArgs): string {
  let result = body;

  // $ALL — all arguments as a single string
  result = result.replace(/\$ALL\b/g, args.raw);

  // $COUNT — number of arguments
  result = result.replace(/\$COUNT\b/g, String(args.positional.length));

  // $FIRST — first argument
  result = result.replace(/\$FIRST\b/g, args.positional[0] || '');

  // $LAST — last argument
  result = result.replace(/\$LAST\b/g, args.positional[args.positional.length - 1] || '');

  // $N — positional arguments (must process AFTER $ALL, $COUNT etc. to avoid conflicts)
  // Replace from highest index down to avoid $10 being matched as $1
  for (let i = args.positional.length; i >= 1; i--) {
    result = result.replace(new RegExp(`\\$${i}\\b`, 'g'), args.positional[i - 1]);
  }

  return result;
}
