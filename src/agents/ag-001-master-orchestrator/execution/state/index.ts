import { ExecutionStatus } from '../../types/index.js';
import { ExecutionStateError } from '../errors/index.js';
import { ExecutionState } from '../types/index.js';
import type { ExecutionStepState } from '../types/index.js';
import type { ExecutionError } from '../types/index.js';
import type { IsoTimestamp } from '../../types/index.js';
import type { ExecutionStep, AgentId } from '../../planning/types/index.js';

/** Valid lifecycle state transitions for an execution (prompt §2). */
const TRANSITIONS: Readonly<Record<ExecutionState, readonly ExecutionState[]>> = {
  [ExecutionState.Pending]: [
    ExecutionState.Planning,
    ExecutionState.Ready,
    ExecutionState.Cancelled,
  ],
  [ExecutionState.Planning]: [
    ExecutionState.Ready,
    ExecutionState.Failed,
    ExecutionState.Cancelled,
  ],
  [ExecutionState.Ready]: [ExecutionState.Running, ExecutionState.Cancelled, ExecutionState.Failed],
  [ExecutionState.Running]: [
    ExecutionState.Completed,
    ExecutionState.Partial,
    ExecutionState.Failed,
    ExecutionState.Cancelled,
    ExecutionState.TimedOut,
  ],
  [ExecutionState.Paused]: [ExecutionState.Running, ExecutionState.Cancelled],
  [ExecutionState.Completed]: [],
  [ExecutionState.Partial]: [],
  [ExecutionState.Failed]: [],
  [ExecutionState.Cancelled]: [],
  [ExecutionState.TimedOut]: [],
};

/** Execution-local, deterministic state manager (prompt §18). */
export class ExecutionStateManager {
  private state: ExecutionState = ExecutionState.Pending;
  private readonly stepStates = new Map<string, ExecutionStepState>();

  get current(): ExecutionState {
    return this.state;
  }

  get snapshot(): ReadonlyMap<string, ExecutionStepState> {
    return new Map(this.stepStates);
  }

  getStepState(stepId: string): ExecutionStepState | undefined {
    return this.stepStates.get(stepId);
  }

  transition(next: ExecutionState): ExecutionState {
    if (next === this.state) {
      return this.state;
    }

    const allowed = TRANSITIONS[this.state];
    if (!allowed.includes(next)) {
      throw new ExecutionStateError(
        `Invalid execution state transition: ${String(this.state)} -> ${String(next)}`,
        { details: { from: this.state, to: next } },
      );
    }

    this.state = next;
    return this.state;
  }

  /** Attempts a transition; returns false instead of throwing (idempotent-safe). */
  tryTransition(next: ExecutionState): boolean {
    if (next === this.state || TRANSITIONS[this.state].includes(next)) {
      this.state = next;
      return true;
    }
    return false;
  }

  /** Marks a single step as started. */
  startStep(step: ExecutionStep, at: IsoTimestamp, attempt = 1): void {
    const existing = this.stepStates.get(step.stepId);
    this.stepStates.set(step.stepId, {
      stepId: step.stepId,
      agentId: step.agentId,
      status: ExecutionStatus.Running,
      attemptCount: Math.max(existing?.attemptCount ?? 0, attempt),
      startedAt: existing?.startedAt ?? at,
    });
  }

  /** Marks a step attempt (retry) with its count. */
  retryStep(step: ExecutionStep, attempt: number): void {
    const existing = this.stepStates.get(step.stepId) ?? {
      stepId: step.stepId,
      agentId: step.agentId,
      status: ExecutionStatus.Running,
      attemptCount: attempt,
    };
    this.stepStates.set(step.stepId, {
      ...existing,
      stepId: step.stepId,
      agentId: step.agentId,
      status: ExecutionStatus.Running,
      attemptCount: attempt,
    });
  }

  /** Marks a step with a terminal/non-running status and optional error. */
  finishStep(
    stepId: string,
    agentId: AgentId,
    status: ExecutionStatus,
    at: IsoTimestamp,
    error?: ExecutionError,
  ): void {
    const existing = this.stepStates.get(stepId);
    this.stepStates.set(stepId, {
      stepId,
      agentId,
      status,
      attemptCount: existing?.attemptCount ?? 1,
      startedAt: existing?.startedAt ?? at,
      completedAt: at,
      lastError: error,
    });
  }
}

export type { ExecutionStepState };
