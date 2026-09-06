/**
 * Sprint 18 — Agentic Tool-Calling. Explicit, deterministic lifecycle.
 *
 * Complex agentic state is never managed with loose booleans. Each session is
 * driven by a state machine whose transitions are validated; illegal moves are
 * rejected with a {@link AgenticStateTransitionError}.
 */

import { AgenticStateTransitionError } from './errors.js';
import { AgenticLoopState } from './contracts.js';

/** Allowed single-step transitions (deterministic, explicit). */
const ALLOWED_TRANSITIONS: Readonly<Record<AgenticLoopState, readonly AgenticLoopState[]>> = {
  [AgenticLoopState.Idle]: [AgenticLoopState.Reasoning],
  [AgenticLoopState.Reasoning]: [
    AgenticLoopState.ToolValidating,
    AgenticLoopState.Completed,
    AgenticLoopState.Clarification,
    AgenticLoopState.Failed,
    AgenticLoopState.Cancelled,
    AgenticLoopState.TimedOut,
    AgenticLoopState.LimitReached,
  ],
  [AgenticLoopState.ToolValidating]: [
    AgenticLoopState.ToolExecuting,
    AgenticLoopState.Reasoning,
    AgenticLoopState.Failed,
    AgenticLoopState.Cancelled,
    AgenticLoopState.TimedOut,
    AgenticLoopState.LimitReached,
  ],
  [AgenticLoopState.ToolExecuting]: [
    AgenticLoopState.ToolResultProcessing,
    AgenticLoopState.Failed,
    AgenticLoopState.Cancelled,
    AgenticLoopState.TimedOut,
    AgenticLoopState.LimitReached,
  ],
  [AgenticLoopState.ToolResultProcessing]: [
    AgenticLoopState.Reasoning,
    AgenticLoopState.Completed,
    AgenticLoopState.Failed,
    AgenticLoopState.Cancelled,
    AgenticLoopState.TimedOut,
    AgenticLoopState.LimitReached,
  ],
  [AgenticLoopState.Completed]: [],
  [AgenticLoopState.Failed]: [],
  [AgenticLoopState.Cancelled]: [],
  [AgenticLoopState.TimedOut]: [],
  [AgenticLoopState.LimitReached]: [],
  [AgenticLoopState.Clarification]: [],
};

/** Terminal (absorbing) states. */
export const AGENTIC_TERMINAL_STATES: readonly AgenticLoopState[] = [
  AgenticLoopState.Completed,
  AgenticLoopState.Failed,
  AgenticLoopState.Cancelled,
  AgenticLoopState.TimedOut,
  AgenticLoopState.LimitReached,
  AgenticLoopState.Clarification,
];

/** A per-session agentic lifecycle tracker. */
export class AgenticLoopStateMachine {
  private _state: AgenticLoopState = AgenticLoopState.Idle;

  get state(): AgenticLoopState {
    return this._state;
  }

  get terminal(): boolean {
    return AGENTIC_TERMINAL_STATES.includes(this._state);
  }

  /** Transitions to `next`; rejects illegal moves deterministically. */
  transition(next: AgenticLoopState): AgenticLoopState {
    if (next === this._state) {
      return this._state;
    }
    const allowed = ALLOWED_TRANSITIONS[this._state];
    if (!allowed.includes(next)) {
      throw new AgenticStateTransitionError(
        `Illegal agentic state transition: ${this._state} -> ${next}`,
        { details: { from: this._state, to: next } },
      );
    }
    this._state = next;
    return next;
  }

  /** True when transitioning to `next` is currently permitted. */
  can(next: AgenticLoopState): boolean {
    if (next === this._state) {
      return true;
    }
    return ALLOWED_TRANSITIONS[this._state].includes(next);
  }
}
