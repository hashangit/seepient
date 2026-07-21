/**
 * T0-3 — Hardware cursor management.
 *
 * Hides the hardware cursor (`\x1b[?25l`) for the entire TUI session. The
 * hardware cursor naturally sits after the last rendered element (the footer),
 * which is below the input box — wrong place. The TextInput component renders
 * its own in-place block cursor (inverted character), so the hardware cursor is
 * redundant and its mispositioning is distracting. Restored on unmount.
 */

import { useEffect } from 'react';

/** Always hide the hardware cursor while mounted; restore on unmount.
 *  Writes directly to process.stdout — Ink doesn't own cursor state. */
export function useCursor(_active: boolean, _blocked: boolean): void {
  useEffect(() => {
    process.stdout.write('\x1b[?25l');
    return () => {
      process.stdout.write('\x1b[?25h');
    };
  }, []);
}
