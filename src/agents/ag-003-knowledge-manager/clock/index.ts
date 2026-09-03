/** Deterministic clock abstraction for the Knowledge Manager. */

/** Injectable time source used by lifecycle/retention logic. */
export interface KnowledgeClock {
  readonly name: string;
  getNow(): Date;
}

/** Production clock backed by the system wall clock. */
export class SystemClock implements KnowledgeClock {
  readonly name = 'system-clock';

  getNow(): Date {
    return new Date();
  }
}

/**
 * Deterministic test clock pinned to a fixed instant. Optionally advances by a
 * fixed step on each read so callers can simulate time passing.
 */
export class FixedClock implements KnowledgeClock {
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

/** Returns the clock's current instant as an ISO-8601 timestamp. */
export function clockToIso(clock: KnowledgeClock): string {
  return clock.getNow().toISOString();
}
