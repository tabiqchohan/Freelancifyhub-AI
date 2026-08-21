/**
 * Deterministic clock abstraction (prompt §4). Business logic must never call
 * `Date.now()` directly — it reads time through a {@link Clock} so TTL and
 * expiration evaluation is fully deterministic under test.
 */

/** Injectable time source used by lifecycle/retention logic. */
export interface Clock {
  readonly name: string;
  /** Returns the current instant. */
  getNow(): Date;
}

/** Production clock backed by the system wall clock. */
export class SystemClock implements Clock {
  readonly name = 'system-clock';

  getNow(): Date {
    return new Date();
  }
}

/**
 * Deterministic test clock pinned to a fixed instant. Optionally advances by a
 * fixed step on each read so callers can simulate time passing.
 */
export class FixedClock implements Clock {
  readonly name = 'fixed-clock';

  private current: Date;

  constructor(
    fixed: Date | string,
    private readonly stepMs = 0,
  ) {
    this.current = new Date(fixed);
  }

  getNow(): Date {
    const now = new Date(this.current);
    this.current = new Date(this.current.getTime() + this.stepMs);
    return now;
  }
}

/** Shared production clock instance. */
export const systemClock: Clock = new SystemClock();

/** Returns the clock's current instant as an ISO-8601 timestamp. */
export function clockToIso(clock: Clock): string {
  return clock.getNow().toISOString();
}
