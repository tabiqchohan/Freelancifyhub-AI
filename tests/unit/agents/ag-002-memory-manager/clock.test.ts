import { describe, expect, it } from 'vitest';

import {
  FixedClock,
  SystemClock,
  clockToIso,
  systemClock,
} from '../../../../src/agents/ag-002-memory-manager/clock/index.js';

describe('Clock - SystemClock', () => {
  it('returns the current wall-clock instant', () => {
    const before = Date.now();
    const now = new SystemClock().getNow().getTime();
    const after = Date.now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(after);
  });

  it('exposes stable metadata', () => {
    const clock = new SystemClock();
    expect(clock.name).toBe('system-clock');
  });

  it('shares a singleton production instance', () => {
    expect(systemClock.name).toBe('system-clock');
  });
});

describe('Clock - FixedClock (determinism, prompt §4)', () => {
  it('returns the pinned instant on every read when no step is set', () => {
    const fixed = new FixedClock('2026-06-01T00:00:00.000Z');
    expect(fixed.getNow().toISOString()).toBe('2026-06-01T00:00:00.000Z');
    expect(fixed.getNow().toISOString()).toBe('2026-06-01T00:00:00.000Z');
  });

  it('accepts a Date and advances deterministically by the configured step', () => {
    const fixed = new FixedClock(new Date('2026-06-01T00:00:00.000Z'), 1000);
    expect(fixed.getNow().toISOString()).toBe('2026-06-01T00:00:00.000Z');
    expect(fixed.getNow().toISOString()).toBe('2026-06-01T00:00:01.000Z');
    expect(fixed.getNow().toISOString()).toBe('2026-06-01T00:00:02.000Z');
  });

  it('is reusable across evaluations without leaking state', () => {
    const a = new FixedClock('2026-01-01T00:00:00.000Z');
    const b = new FixedClock('2026-01-01T00:00:00.000Z');
    expect(a.getNow().toISOString()).toBe(b.getNow().toISOString());
  });
});

describe('Clock - clockToIso', () => {
  it('returns the instant as an ISO-8601 string', () => {
    const iso = clockToIso(new FixedClock('2026-06-01T12:00:00.000Z'));
    expect(iso).toBe('2026-06-01T12:00:00.000Z');
  });
});
