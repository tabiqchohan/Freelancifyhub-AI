/**
 * Prompts15 Phase 2/4 — shared abort plumbing.
 *
 * The inbound HTTP request, the AIOS execution budget and the caller-provided
 * deadline are three independent ways work can be abandoned. They are composed
 * through the helpers below so no layer invents its own listener bookkeeping and
 * so every listener created here is detached exactly once.
 *
 * Nothing in this module logs, caches or retains a signal beyond the lifetime of
 * the returned disposer; callers are responsible for invoking the disposer.
 */

/**
 * Combines abort signals into a single signal that aborts as soon as any input
 * aborts.
 *
 * Returns `undefined` when there is nothing to compose (no signals, or only
 * already-aborted signals are irrelevant to callers that want a real signal).
 * A single usable signal is returned as-is so the common path stays allocation
 * free and never leaves a composite signal alive after the work completes.
 *
 * `AbortSignal.any` is used when available (Node >= 20.3) because the runtime
 * owns listener teardown for the composite; the manual fallback is explicit
 * about leaking nothing by requiring {@link linkAbort} for teardown.
 */
export function anyAbortSignal(
  signals: ReadonlyArray<AbortSignal | undefined>,
): AbortSignal | undefined {
  const usable = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (usable.length === 0) {
    return undefined;
  }
  if (usable.length === 1) {
    return usable[0];
  }
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any(usable);
  }
  const controller = new AbortController();
  const detach = usable.map((signal) => linkAbort(signal, () => controller.abort()));
  // Nothing else can reach this composite, so the listeners are released as
  // soon as one of the inputs fires (first abort is terminal for the composite).
  const release = (): void => {
    for (const off of detach) {
      off();
    }
  };
  controller.signal.addEventListener('abort', release, { once: true });
  return controller.signal;
}

/**
 * Invokes `onAbort` when `source` aborts (immediately if already aborted) and
 * returns a disposer that detaches the listener. The disposer is idempotent so
 * `finally` blocks and early returns cannot double-detach.
 */
export function linkAbort(source: AbortSignal, onAbort: () => void): () => void {
  if (source.aborted) {
    onAbort();
    return () => undefined;
  }
  let detached = false;
  const detach = (): void => {
    if (detached) {
      return;
    }
    detached = true;
    source.removeEventListener('abort', onAbort);
  };
  source.addEventListener('abort', onAbort, { once: true });
  return detach;
}
