/** Clock abstraction for deterministic time handling. */

export interface ToolClock {
  readonly now: number;
  nowIso(): string;
}

/** Real system clock. */
export class SystemToolClock implements ToolClock {
  get now(): number {
    return Date.now();
  }
  nowIso(): string {
    return new Date().toISOString();
  }
}

/** Fixed clock for deterministic tests. */
export class FixedToolClock implements ToolClock {
  private readonly fixed: number;
  constructor(fixed = 1_700_000_000_000) {
    this.fixed = fixed;
  }
  get now(): number {
    return this.fixed;
  }
  nowIso(): string {
    return new Date(this.fixed).toISOString();
  }
}
