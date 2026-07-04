import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { ToolModule, ToolExecExtra } from './interface.js';

export const ShellTool: ToolModule = {
  name: "Shell Execution",
  risk: "destructive",
  definition: {
    type: "function",
    function: {
      name: "execute_shell_command",
      description: "Execute a shell command on the host machine. Use this to run scripts, list files, or interact with the system.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The shell command to execute." },
          rationale: { type: "string", description: "Explain why you are running this command." }
        },
        required: ["command", "rationale"]
      }
    }
  },
  // Runs via `spawn(shell:true)` (same shell as the former `exec`) so stdout
  // can stream live via onUpdate; the resolved string matches the old format
  // (stdout + optional "Stderr:" suffix) so headless output is unchanged.
  handler: async (args: any, _config: any, extra?: ToolExecExtra) => {
    const onUpdate = extra?.onUpdate;
    return new Promise<string>((resolve) => {
      let stdout = '';
      let stderr = '';
      const child = spawn(args.command, { shell: true });
      child.stdout?.on('data', (data: Buffer) => {
        const chunk = data.toString();
        stdout += chunk;
        if (onUpdate) onUpdate({ message: chunk });
      });
      child.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });
      child.on('error', (err: Error) => {
        resolve(`Command failed: ${err.message}\nStdout: ${stdout}\nStderr: ${stderr}`);
      });
      child.on('close', (code: number | null) => {
        if (code === 0) {
          resolve(stdout + (stderr ? `\nStderr: ${stderr}` : ''));
        } else {
          resolve(`Command failed: ${args.command} (exit ${code ?? 'null'})\nStdout: ${stdout}\nStderr: ${stderr}`);
        }
      });
    });
  }
};

export const ReadFileTool: ToolModule = {
  name: "File Reader",
  risk: "safe",
  definition: {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the content of a file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "The path to the file to read." }
        },
        required: ["path"]
      }
    }
  },
  handler: async (args: any) => {
    try {
      const content = await fs.readFile(args.path, 'utf-8');
      return content;
    } catch (error: any) {
      return `Error reading file: ${error.message}`;
    }
  }
};

/** Diff-viewer payload for `write_file`. Owned by the producer (this module);
 *  the TUI parses it via `isFileWriteMetadata`. `oldContent`/`newContent` are
 *  omitted when `diffSkipped` (oversized) so we don't hold large strings. */
export interface FileWriteMetadata {
  path: string;
  isNewFile: boolean;
  byteDelta: number;
  oldContent?: string | null;   // null ⇒ new file; omitted when diffSkipped
  newContent?: string;          // omitted when diffSkipped
  diffSkipped?: boolean;
  skipReason?: string;
  /** Index signature so this typed payload satisfies ToolResult.metadata's
   *  Record<string, unknown> without a cast at the producer site. */
  [key: string]: unknown;
}

/** Files larger than this (bytes OR lines) skip the inline diff to avoid
 *  dumping a huge render into the TUI. */
const DIFF_BYTE_CAP = 64 * 1024;
const DIFF_LINE_CAP = 2000;

/** Line count that treats a trailing newline as the end of the last line, not
 *  the start of an empty one: "a\nb\n" is 2 lines, "a\nb" is 2, "a\n" is 1. */
const lineCount = (text: string): number => {
  if (text === "") return 0;
  const newlines = text.split("\n").length - 1;
  return text.endsWith("\n") ? newlines : newlines + 1;
};

/** Temps younger than this are assumed to belong to a live write (possibly a
 *  concurrent process) and are left alone; only older orphans are swept. */
const STALE_TEMP_AGE_MS = 60_000;

/** Remove orphaned `.seepient-*.tmp` write temps for `basename` in `dir` — left
 *  behind by a hard kill (SIGKILL/power loss) in the window between temp-write
 *  and rename, which the handler's catch block can't reach. Only temps older
 *  than STALE_TEMP_AGE_MS are removed, so a peer's in-flight temp is never
 *  touched (no cross-process race). Best-effort; errors swallowed. */
async function cleanStaleTemps(dir: string, basename: string): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return; // dir doesn't exist yet (new file in a new dir) — nothing to sweep
  }
  const prefix = `${basename}.seepient-`;
  const cutoff = Date.now() - STALE_TEMP_AGE_MS;
  await Promise.all(
    entries
      .filter((e) => e.startsWith(prefix) && e.endsWith(".tmp"))
      .map(async (e) => {
        const full = path.join(dir, e);
        try {
          const st = await fs.stat(full);
          if (st.mtimeMs < cutoff) await fs.unlink(full);
        } catch { /* raced with another sweeper or already gone — ignore */ }
      }),
  );
}

export const WriteFileTool: ToolModule = {
  name: "File Writer",
  risk: "edit",
  definition: {
    type: "function",
    function: {
      name: "write_file",
      description: "Write content to a file. Overwrites existing files.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "The path to the file to write." },
          content: { type: "string", description: "The content to write." }
        },
        required: ["path", "content"]
      }
    }
  },
  handler: async (args: any) => {
    const filePath: string = args.path;
    const newContent: string = args.content;

    // 1. Stat the target (size only — never slurp a huge file). Read the old
    //    content ONLY when neither side already exceeds the byte/line caps, so a
    //    large write doesn't pay for a pointless read. The line cap applies to
    //    BOTH sides — a small-but-thousands-of-lines file diffs just as badly.
    let fileExists = false;
    let oldBytes = 0;
    try {
      const st = await fs.stat(filePath);
      fileExists = true;
      oldBytes = st.size;
    } catch {
      // absent ⇒ new file
    }
    const isNewFile = !fileExists;
    const newBytes = Buffer.byteLength(newContent, "utf-8");
    const newOverCap = newBytes > DIFF_BYTE_CAP || lineCount(newContent) > DIFF_LINE_CAP;
    const oldByteOverCap = oldBytes > DIFF_BYTE_CAP;

    let oldContent: string | null = null;
    let oldLineOverCap = false;
    if (!newOverCap && !oldByteOverCap) {
      try {
        oldContent = await fs.readFile(filePath, "utf-8");
        oldLineOverCap = lineCount(oldContent) > DIFF_LINE_CAP;
      } catch {
        // absent ⇒ new file (oldContent stays null)
      }
    }
    const overCap = newOverCap || oldByteOverCap || oldLineOverCap;

    // 2. Atomic write: temp file in the SAME directory (same filesystem ⇒
    //    fs.rename is atomic on POSIX), then rename. On any failure the temp
    //    is unlinked and the original is never partially written. A same-path
    //    temp orphaned by a prior hard kill is swept first.
    const dir = path.dirname(filePath);
    const tmpPath = `${filePath}.seepient-${randomUUID().slice(0, 8)}.tmp`;
    await cleanStaleTemps(dir, path.basename(filePath));
    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(tmpPath, newContent, "utf-8");
      await fs.rename(tmpPath, filePath);
    } catch (error: any) {
      try { await fs.unlink(tmpPath); } catch { /* temp may not have been created */ }
      return { output: `Error writing file: ${error.message}`, success: false };
    }

    // 3. Build metadata for the diff viewer. `overCap` already accounts for both
    //    sides (byte AND line), so a small edit to a large/many-line file skips
    //    the diff instead of storing/rendering the whole old file. Full content
    //    is omitted when over cap.
    const metadata: FileWriteMetadata = overCap
      ? {
          path: filePath,
          isNewFile,
          byteDelta: newBytes - oldBytes,
          diffSkipped: true,
          skipReason: `file exceeds ${DIFF_BYTE_CAP} bytes or ${DIFF_LINE_CAP} lines`,
        }
      : {
          path: filePath,
          oldContent,
          newContent,
          isNewFile,
          byteDelta: newBytes - oldBytes,
        };

    return {
      output: `Successfully wrote to ${filePath} (${lineCount(oldContent ?? "")} -> ${lineCount(newContent)} lines)`,
      success: true,
      metadata,
    };
  }
};

export const DateTimeTool: ToolModule = {
  name: "Date & Time",
  risk: "safe",
  definition: {
    type: "function",
    function: {
      name: "get_current_datetime",
      description: "Get the current system date and time. Use this when the user refers to relative dates (like 'today', 'next week', 'this March') to ensure accuracy.",
      parameters: {
        type: "object",
        properties: {},
        required: []
      }
    }
  },
  handler: async () => {
    const now = new Date();
    return JSON.stringify({
      iso: now.toISOString(),
      local: now.toLocaleString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      weekday: now.toLocaleDateString('en-US', { weekday: 'long' })
    }, null, 2);
  }
};
