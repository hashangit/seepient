/**
 * T0-1 — Throttled streaming flush.
 *
 * Buffer tokens in a ref; flush to state on a ~33ms interval (≈30fps);
 * clear the timer on commit/abort. The `onFlush` callback is stored in a ref
 * so callers can pass inline arrows without triggering identity churn.
 */

import { useRef, useCallback, useMemo } from 'react';

export interface StreamFlushHandle {
  schedule(): void;
  flushNow(): void;
  cancel(): void;
}

const FLUSH_INTERVAL_MS = 33; // ~30fps

export function useStreamFlush(onFlush: () => void): StreamFlushHandle {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onFlushRef = useRef(onFlush);
  onFlushRef.current = onFlush;

  const schedule = useCallback((): void => {
    if (timerRef.current) return;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      onFlushRef.current();
    }, FLUSH_INTERVAL_MS);
  }, []);

  const flushNow = useCallback((): void => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    onFlushRef.current();
  }, []);

  const cancel = useCallback((): void => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  return useMemo(() => ({ schedule, flushNow, cancel }), [schedule, flushNow, cancel]);
}
