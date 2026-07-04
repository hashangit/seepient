/**
 * Seepient SDK — Hook executor
 *
 * Wraps a user-supplied `Hooks` object in a safe executor that:
 *  - treats missing hooks as no-ops
 *  - awaits async hooks
 *  - catches and logs hook errors without failing the main flow
 */

import type {
  Hooks,
  StepResult,
  SeepientError,
  GenerateTextResult,
} from "./types.js";

// ── HookExecutor interface ───────────────────────────────────────────
// Defined here because it is not exported from types.ts.
// This is the public contract returned by `createHookExecutor()`.

export interface HookExecutor {
  beforeToolCall(call: { name: string; args: Record<string, unknown> }): Promise<void>;
  afterToolCall(result: { name: string; output: string; duration: number }): Promise<void>;
  onStep(step: StepResult): Promise<void>;
  onError(error: SeepientError): Promise<void>;
  onFinish(result: GenerateTextResult): Promise<void>;
}

/**
 * Create a safe hook executor from an optional `Hooks` object.
 *
 * Every method on the returned `HookExecutor` is safe to call even when
 * the caller provided no hooks — undefined hooks are treated as no-ops,
 * and any error thrown by a hook is caught, logged, and swallowed so
 * the main agent loop is never disrupted.
 *
 * @param hooks  Optional user-supplied hooks
 * @returns      A `HookExecutor` whose methods are always safe to invoke
 */
export function createHookExecutor(hooks?: Hooks): HookExecutor {
  const h = hooks ?? {};

  async function run(
    fn: (() => void | Promise<void>) | undefined,
    label: string,
  ): Promise<void> {
    if (fn == null) return;
    try {
      await fn();
    } catch (err) {
      console.error(`[seepient] ${label} hook error:`, err);
    }
  }

  return {
    async beforeToolCall(call) {
      await run(() => h.beforeToolCall?.(call), "beforeToolCall");
    },

    async afterToolCall(result) {
      await run(() => h.afterToolCall?.(result), "afterToolCall");
    },

    async onStep(step) {
      await run(() => h.onStep?.(step), "onStep");
    },

    async onError(error) {
      await run(() => h.onError?.(error), "onError");
    },

    async onFinish(result) {
      await run(() => h.onFinish?.(result), "onFinish");
    },
  };
}
