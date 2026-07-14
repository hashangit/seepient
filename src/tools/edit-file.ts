/**
 * T3 — edit_file tool module.
 *
 * Hash-anchored line patch for targeted file edits. Reuses 006's
 * FileWriteMetadata so DiffViewer works unchanged.
 *
 * See `contracts/hashline-edit.md`.
 */

import type { ToolModule } from './interface.js';
import { APPROVAL_SCHEMA } from './interface.js';
import type { SnapshotStore } from '../core/hashline/snapshot-store.js';
import { applyPatch } from '../core/hashline/patcher.js';
import { HashlineError } from '../core/errors.js';

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
            description: 'One or more [PATH#TAG] sections. TAG is the 4-hex content hash returned by read_file. Operations: SWAP A.=B:, SWAP.BLK A:, DEL A.=B, DEL.BLK A, INS.PRE A:, INS.POST A:, INS.HEAD:, INS.TAIL:. Body rows prefixed with +. Order multiple operations from bottom-to-top (highest line first) so line numbers stay correct.',
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
