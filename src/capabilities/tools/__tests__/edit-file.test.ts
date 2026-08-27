/**
 * edit_file integration test — verifies the end-to-end path from
 * read_file (tag recording) → agent constructs [PATH#TAG] → edit_file
 * handler → file written + metadata emitted.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createSnapshotStore } from '../../../foundations/hashline/snapshot-store.js';
import { ReadFileTool } from '../core.js';
import { EditFileTool } from '../edit-file.js';
import type { ToolResult } from '../../../foundations/types.js';

describe('edit_file integration', () => {
  let tmpDir: string;
  let store: ReturnType<typeof createSnapshotStore>;

  afterEach(async () => {
    if (tmpDir) {
      try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  async function setupFile(name: string, content: string): Promise<string> {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'seepient-edit-test-'));
    const filePath = path.join(tmpDir, name);
    await fs.writeFile(filePath, content, 'utf8');
    store = createSnapshotStore();
    return filePath;
  }

  it('reads a file, records a tag, then edits it via hash-anchored patch', async () => {
    const filePath = await setupFile('fruits.txt', 'apple\nbanana\ncherry\ndate');

    // 1. read_file records a snapshot and returns content + tag
    const readResult = await ReadFileTool.handler!({ path: filePath }, { snapshotStore: store });
    expect(typeof readResult).toBe('string');
    const tagMatch = (readResult as string).match(/\[content-tag:([0-9a-f]{4})\]/);
    expect(tagMatch).not.toBeNull();
    const tag = tagMatch![1];

    // 2. Agent builds [PATH#TAG] section and calls edit_file
    const patch = `[${filePath}#${tag}]
SWAP 3.=3:
+kumquat`;
    const editResult = await EditFileTool.handler!({ patch }, { snapshotStore: store });
    expect(editResult).toMatchObject({ output: expect.stringContaining(filePath), success: true });

    // 3. File content is updated
    const newContent = await fs.readFile(filePath, 'utf8');
    expect(newContent).toBe('apple\nbanana\nkumquat\ndate');

    // 4. metadata is a valid entry
    const meta = (editResult as any).metadata;
    expect(meta).toBeDefined();
    expect(meta.path).toBe(filePath);
    expect(meta.isNewFile).toBe(false);
    expect(meta.oldContent).toBe('apple\nbanana\ncherry\ndate');
    expect(meta.newContent).toBe('apple\nbanana\nkumquat\ndate');
  });

  it('rejects edit when tag is unknown', async () => {
    const patch = '[/fake/path.txt#ffff]\nSWAP 1.=1:\n+hello';
    store = createSnapshotStore();
    await expect(
      EditFileTool.handler!({ patch }, { snapshotStore: store }),
    ).rejects.toThrow(/No snapshot for path|Unknown tag/);
  });

  it('rejects edit when content changed (stale anchor)', async () => {
    const filePath = await setupFile('stale.txt', 'alpha\nbeta\ngamma');

    // Read and record original content
    const readResult = await ReadFileTool.handler!({ path: filePath }, { snapshotStore: store });
    const tag = (readResult as string).match(/\[content-tag:([0-9a-f]{4})\]/)![1];

    // External change between read and edit
    await fs.appendFile(filePath, '\nDELTA');

    const patch = `[${filePath}#${tag}]
SWAP 2.=2:
+beta_new`;
    await expect(
      EditFileTool.handler!({ patch }, { snapshotStore: store }),
    ).rejects.toThrow(/Stale anchor/);

    // File content is preserved (no silent data loss)
    const content = await fs.readFile(filePath, 'utf8');
    expect(content).toBe('alpha\nbeta\ngamma\nDELTA');
  });

  it('edits two files in one patch and returns multi-file metadata', async () => {
    const f1 = await setupFile('a.txt', 'hello\nworld');
    // setupFile overwrites tmpDir; we'll create f2 manually in same dir
    const f2 = path.join(tmpDir, 'b.txt');
    await fs.writeFile(f2, 'foo\nbar\nbaz', 'utf8');

    // Read both to record snapshots
    const r1 = (await ReadFileTool.handler!({ path: f1 }, { snapshotStore: store })) as string;
    const r2 = (await ReadFileTool.handler!({ path: f2 }, { snapshotStore: store })) as string;
    const t1 = r1.match(/\[content-tag:([0-9a-f]{4})\]/)![1];
    const t2 = r2.match(/\[content-tag:([0-9a-f]{4})\]/)![1];

    const patch = `[${f1}#${t1}]
SWAP 2.=2:
+WORLD

[${f2}#${t2}]
DEL 2.=2`;
    const result = (await EditFileTool.handler!({ patch }, { snapshotStore: store })) as ToolResult;
    expect(result.success).toBe(true);
    expect(result.output).toContain('Edited 2 file(s)');

    const meta = result.metadata as Record<string, unknown>;
    expect(meta).toBeDefined();
    expect(Array.isArray(meta.edits)).toBe(true);
    const edits = meta.edits as Array<Record<string, unknown>>;
    expect(edits).toHaveLength(2);
    expect(edits[0].path).toBe(f1);
    expect(edits[1].path).toBe(f2);

    // Verify on-disk content
    expect(await fs.readFile(f1, 'utf8')).toBe('hello\nWORLD');
    expect(await fs.readFile(f2, 'utf8')).toBe('foo\nbaz');
  });

  it('multi-section patch is atomic: section 1 not written when section 2 fails', async () => {
    const f1 = await setupFile('a.txt', 'hello\nworld');
    const f2 = path.join(tmpDir, 'b.txt');
    await fs.writeFile(f2, 'foo\nbar', 'utf8');

    // Read f1 only — f2 has no snapshot, so section 2 must fail.
    const r1 = (await ReadFileTool.handler!({ path: f1 }, { snapshotStore: store })) as string;
    const t1 = r1.match(/\[content-tag:([0-9a-f]{4})\]/)![1];

    const patch = `[${f1}#${t1}]
SWAP 1.=1:
+HELLO

[${f2}#0000]
SWAP 1.=1:
+FOO`;

    await expect(
      EditFileTool.handler!({ patch }, { snapshotStore: store }),
    ).rejects.toThrow(/No snapshot for path|Unknown tag/);

    // Critical: f1 (section 1) must be UNCHANGED — no partial multi-file edit.
    expect(await fs.readFile(f1, 'utf8')).toBe('hello\nworld');
    expect(await fs.readFile(f2, 'utf8')).toBe('foo\nbar');
  });
});
