/**
 * T3 — edit_file tool module.
 *
 * Hash-anchored line patch for targeted file edits. Reuses 006's
 * FileWriteMetadata so DiffViewer works unchanged.
 *
 * See `contracts/hashline-edit.md`.
 */

import type { ToolModule } from '../../foundations/contracts/tool.js';
import { APPROVAL_SCHEMA } from '../../foundations/contracts/tool.js';
import type { SnapshotStore } from '../../foundations/hashline/snapshot-store.js';
import { applyPatch } from '../../foundations/hashline/patcher.js';
import { HashlineError } from '../../foundations/errors.js';

export const EditFileTool: ToolModule = {
  name: 'Edit File (hashline)',
  risk: 'edit',
  definition: {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Apply a hash-anchored line patch to one or more files. Prefer this over write_file for targeted edits to existing files — smaller payload, fewer reproduction errors. Use write_file only for new files or full rewrites.',
      parameters: {
        type: 'object',
        required: ['patch'],
        properties: {
          patch: {
            type: 'string',
            description: [
              'Hashline patch. First read_file the target; its output ends with [content-tag:XXXX], and that tag anchors the patch.',
              'Format: one [PATH#TAG] section header per file, then operations. Replacement/inserted content goes on the lines AFTER the op line, each prefixed with "+". A.=B is a line range; a single line is written 2.=2.',
              'Example — replace line 2 of /src/app.ts (tag a1f2):',
              '[/src/app.ts#a1f2]',
              'SWAP 2.=2:',
              '+const x = 2;',
              'Ops: SWAP A.=B: (replace lines A–B with body) · SWAP.BLK A: (replace indentation block at A) · DEL A.=B (delete lines A–B; no colon, no body) · DEL.BLK A (delete block) · INS.PRE A: / INS.POST A: (insert body before/after line A) · INS.HEAD: / INS.TAIL: (insert at top/end).',
              'When stacking multiple ops in one section, order bottom-to-top (highest line first) so line numbers stay valid.',
            ].join('\n'),
          },
          approval: APPROVAL_SCHEMA,
        },
      },
    },
  },
  handler: async (args: any, config?: any) => {
    const store = config?.snapshotStore as SnapshotStore | undefined;
    if (!store) {
      throw new HashlineError('edit_file requires a snapshot store', 'HASHLINE_NO_STORE', false);
    }

    const result = await applyPatch(args.patch, store);
    return {
      output: result.output,
      success: result.success,
      metadata: result.metadata as unknown as Record<string, unknown>,
    };
  },
};
