import { MemoryLifecycleState } from '../enums/index.js';
import { MemoryLifecycleTransitionError } from '../errors/index.js';

/**
 * Lifecycle transition contract (spec §5, prompt §5). Invalid transitions
 * produce a typed {@link MemoryLifecycleTransitionError} — they are never
 * silently accepted.
 */
export interface MemoryLifecycleContract {
  readonly name: string;
  /** All allowed transitions keyed by source state. */
  readonly allowed: Readonly<Record<MemoryLifecycleState, readonly MemoryLifecycleState[]>>;
  /** Whether the transition is valid. */
  canTransition(from: MemoryLifecycleState, to: MemoryLifecycleState): boolean;
  /** Validates the transition and returns the target state, else throws. */
  transition(from: MemoryLifecycleState, to: MemoryLifecycleState): MemoryLifecycleState;
}

/**
 * Canonical transitions derived from the architecture state diagram (spec §5).
 *
 * - `Created → Active` on successful persist.
 * - `Active → Archived | Expired | Deleted` (TTL/retention, DSR).
 * - `Expired → Archived | Deleted` (retention sweep).
 * - `Archived → Active` (restore/recovery) or `Archived → Deleted`.
 * - `Deleted` is terminal: `DELETED → ACTIVE` is invalid.
 *
 * Summarized/Compressed/Recovered are transient phases in the spec (not stored
 * states) and arrive with the summarization/consolidation sprints.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<MemoryLifecycleState, readonly MemoryLifecycleState[]>> =
  {
    [MemoryLifecycleState.Created]: [MemoryLifecycleState.Active],
    [MemoryLifecycleState.Active]: [
      MemoryLifecycleState.Archived,
      MemoryLifecycleState.Expired,
      MemoryLifecycleState.Deleted,
    ],
    [MemoryLifecycleState.Expired]: [MemoryLifecycleState.Archived, MemoryLifecycleState.Deleted],
    [MemoryLifecycleState.Archived]: [MemoryLifecycleState.Active, MemoryLifecycleState.Deleted],
    [MemoryLifecycleState.Deleted]: [],
  };

/** Deterministic lifecycle implementation based on the spec state diagram. */
export class DefaultMemoryLifecycle implements MemoryLifecycleContract {
  readonly name = 'default-memory-lifecycle';
  readonly allowed = ALLOWED_TRANSITIONS;

  canTransition(from: MemoryLifecycleState, to: MemoryLifecycleState): boolean {
    return (this.allowed[from] ?? []).includes(to);
  }

  transition(from: MemoryLifecycleState, to: MemoryLifecycleState): MemoryLifecycleState {
    if (!this.canTransition(from, to)) {
      throw new MemoryLifecycleTransitionError(
        `Invalid memory lifecycle transition ${from} → ${to}`,
        { details: { from, to } },
      );
    }
    return to;
  }
}

/** Shared deterministic lifecycle instance. */
export const memoryLifecycle: MemoryLifecycleContract = new DefaultMemoryLifecycle();
