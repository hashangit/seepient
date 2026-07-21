/**
 * Grant pattern extraction — the shared rule for what a permission grant
 * matches against. Pure vocabulary: the Domain records grants with it, the
 * UI displays pending grants with it, neither imports the other for it.
 */

/**
 * Extract the prefix string a grant should match for this tool call.
 * Uniform shape across tools: a string the relevant arg must start with.
 *  - execute_shell_command → the command string ("npm test")
 *  - write_file            → the path arg
 *  - edit_file             → the path of the first [PATH#TAG] section in the patch
 *  - anything else         → undefined (tool-level)
 *
 * For edit_file, the path lives inside the patch string as `[PATH#TAG]`
 * sections (mirrors the hashline parser's section header). A single patch may
 * span multiple files — we use the first section's path as the pattern. If a
 * grant needs to cover multi-file patches, create it at tool-level (the grant
 * with no pattern).
 */
export function extractPattern(
  toolName: string,
  args: Record<string, unknown>,
): string | undefined {
  if (toolName === "execute_shell_command") {
    const cmd = args.command;
    return typeof cmd === "string" && cmd.length > 0 ? cmd : undefined;
  }
  if (toolName === "write_file") {
    const p = args.path;
    return typeof p === "string" && p.length > 0 ? p : undefined;
  }
  if (toolName === "edit_file") {
    const patch = args.patch;
    if (typeof patch !== "string" || patch.length === 0) return undefined;
    // First [PATH#TAG] section header — same shape as the hashline parser.
    const m = patch.match(/^\[(.+)#[0-9a-f]{4}\]/im);
    return m ? m[1] : undefined;
  }
  return undefined;
}
