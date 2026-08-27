import { useInput } from 'ink';

export interface KeybindingHandlers {
  onAbort: () => void;
  onExit: () => void;
  onExpandToggle: () => void;
  onPalette: () => void;
  onClear: () => void;
  /** Ctrl+T at idle cycles focus from prompt to first live widget. */
  onCycleFocus?: () => void;
  /** Escape at idle when a widget is focused returns focus to the prompt. */
  onEscapeWidget?: () => void;
  /** Shift+Tab cycles consent modes (spec 017, T028). */
  onCycleMode?: () => void;
}

export interface KeybindingOptions {
  enabled: boolean;
  isRunning: boolean;
  /**
   * True while a permission prompt is open. Escape then belongs to the
   * prompt (deny the request, spec 011 FR-015) and must not also abort the
   * whole run; Ctrl+C remains the hard abort.
   */
  promptPending?: boolean;
}

/**
 * Global keybindings. Disabled while a modal overlay is open (`enabled: false`)
 * so the overlay owns input. Ctrl+C aborts mid-run or exits when idle.
 * (Help is `/?`, not bare `?` — bare `?` would fire mid-question.)
 */
export function useKeybindings(
  handlers: KeybindingHandlers,
  opts: KeybindingOptions,
): void {
  useInput((input, key) => {
    if (!opts.enabled) return;
    if (key.ctrl) {
      if (input === 'o' || input === '\x0f') handlers.onExpandToggle();
      else if (input === 'p' || input === '\x10') handlers.onPalette();
      else if (input === 'l' || input === '\x0c') handlers.onClear();
      else if (input === 't' || input === '\x14') {
        if (!opts.isRunning && handlers.onCycleFocus) handlers.onCycleFocus();
      }
      else if (input === 'c' || input === '\x03') (opts.isRunning ? handlers.onAbort() : handlers.onExit());
      return;
    }
    if ((key.shift && key.tab) || input === '\x1b[Z') {
      if (!opts.isRunning && handlers.onCycleMode) {
        handlers.onCycleMode();
        return;
      }
    }
    if (key.escape) {
      // The permission prompt's own useInput receives the same keypress and
      // denies the request; a second deny-and-abort here would kill the
      // run (review round 10, FR-015).
      if (opts.promptPending) return;
      if (!opts.isRunning && handlers.onEscapeWidget) handlers.onEscapeWidget();
      else handlers.onAbort();
    }
  });
}
