import { describe, expect, it } from 'vitest';

import { MemoryLifecycleState } from '../../../../src/agents/ag-002-memory-manager/enums/index.js';
import { MemoryLifecycleTransitionError } from '../../../../src/agents/ag-002-memory-manager/errors/index.js';
import {
  DefaultMemoryLifecycle,
  memoryLifecycle,
} from '../../../../src/agents/ag-002-memory-manager/lifecycle/index.js';

const S = MemoryLifecycleState;
const lifecycle = new DefaultMemoryLifecycle();

describe('MemoryLifecycle - allowed transitions (spec §5, prompt §5)', () => {
  it('allows Created → Active', () => {
    expect(lifecycle.canTransition(S.Created, S.Active)).toBe(true);
    expect(lifecycle.transition(S.Created, S.Active)).toBe(S.Active);
  });

  it('allows Active → Archived / Expired / Deleted', () => {
    expect(lifecycle.canTransition(S.Active, S.Archived)).toBe(true);
    expect(lifecycle.canTransition(S.Active, S.Expired)).toBe(true);
    expect(lifecycle.canTransition(S.Active, S.Deleted)).toBe(true);
  });

  it('allows Expired → Archived / Deleted', () => {
    expect(lifecycle.canTransition(S.Expired, S.Archived)).toBe(true);
    expect(lifecycle.canTransition(S.Expired, S.Deleted)).toBe(true);
  });

  it('allows Archived → Active (restore/recovery) and Archived → Deleted', () => {
    expect(lifecycle.canTransition(S.Archived, S.Active)).toBe(true);
    expect(lifecycle.canTransition(S.Archived, S.Deleted)).toBe(true);
  });
});

describe('MemoryLifecycle - invalid transitions are rejected', () => {
  it('never allows DELETED → ACTIVE', () => {
    expect(lifecycle.canTransition(S.Deleted, S.Active)).toBe(false);
    expect(() => lifecycle.transition(S.Deleted, S.Active)).toThrow(MemoryLifecycleTransitionError);
  });

  it('never allows DELETED → anything (terminal state)', () => {
    for (const target of Object.values(S)) {
      expect(lifecycle.canTransition(S.Deleted, target)).toBe(false);
    }
  });

  it('rejects created → archived and other non-edge transitions', () => {
    expect(lifecycle.canTransition(S.Created, S.Archived)).toBe(false);
    expect(() => lifecycle.transition(S.Created, S.Archived)).toThrow(
      MemoryLifecycleTransitionError,
    );
  });

  it('throws a typed error carrying from/to details', () => {
    try {
      lifecycle.transition(S.Deleted, S.Active);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(MemoryLifecycleTransitionError);
      const typed = error as MemoryLifecycleTransitionError;
      expect(typed.code).toBe('MEMORY_LIFECYCLE_TRANSITION_ERROR');
      expect(typed.details).toEqual({ from: S.Deleted, to: S.Active });
    }
  });
});

describe('MemoryLifecycle - shared instance and contract metadata', () => {
  it('is deterministic and exposes the allowed map', () => {
    expect(memoryLifecycle.name).toBe('default-memory-lifecycle');
    expect(memoryLifecycle.allowed[S.Deleted]).toEqual([]);
    expect(memoryLifecycle.allowed[S.Active]).toContain(S.Archived);
  });
});
