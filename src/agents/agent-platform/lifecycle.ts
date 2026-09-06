/**
 * Sprint 19 — Agent Capability Framework & Lifecycle. State machine + controller.
 *
 * The lifecycle is the operational runtime axis of an agent (READY/RUNNING/
 * DRAINING/...). It is deliberately separate from the Agent Catalog's static
 * {@link AgentStatus} (Draft/InDevelopment/Production), which describes rolled
 * deployment status. No arbitrary mutation is possible: every transition is
 * validated against a single deterministic table.
 */

import type { AgentId, IsoTimestamp } from '../ag-001-master-orchestrator/types/index.js';
import type { AgentPlatformEvent, AgentPlatformEventLog } from './events.js';
import {
  agentDisabledEvent,
  agentDrainingEvent,
  agentFailedEvent,
  agentInitializingEvent,
  agentPausedEvent,
  agentReadyEvent,
  agentRecoveredEvent,
  agentRegisteredEvent,
  agentResumedEvent,
  agentStartedEvent,
  agentTerminatedEvent,
} from './events.js';
import type { AgentPlatformMetrics } from './metrics.js';
import {
  AgentAlreadyRegisteredError,
  AgentDisabledError,
  AgentLifecycleInvalidError,
  AgentNotReadyError,
  AgentTerminatedError,
} from './errors.js';

const noop = (): void => undefined;

/** Operational lifecycle states of an agent (Sprint 19 §11). */
export enum AgentLifecycleState {
  Registered = 'REGISTERED',
  Initializing = 'INITIALIZING',
  Ready = 'READY',
  Running = 'RUNNING',
  Draining = 'DRAINING',
  Paused = 'PAUSED',
  Disabled = 'DISABLED',
  Failed = 'FAILED',
  Terminated = 'TERMINATED',
}

/** Per-state counts plus in-flight executions at a point in time. */
export interface AgentLifecycleSummary {
  readonly states: Readonly<Record<AgentLifecycleState, number>>;
  readonly activeExecutions: number;
}

/** Deterministic transition table (Sprint 19 §11). */
const TRANSITIONS: Readonly<Record<AgentLifecycleState, readonly AgentLifecycleState[]>> = {
  [AgentLifecycleState.Registered]: [
    AgentLifecycleState.Initializing,
    AgentLifecycleState.Disabled,
    AgentLifecycleState.Failed,
    AgentLifecycleState.Terminated,
  ],
  [AgentLifecycleState.Initializing]: [
    AgentLifecycleState.Ready,
    AgentLifecycleState.Failed,
    AgentLifecycleState.Disabled,
    AgentLifecycleState.Terminated,
  ],
  [AgentLifecycleState.Ready]: [
    AgentLifecycleState.Running,
    AgentLifecycleState.Paused,
    AgentLifecycleState.Draining,
    AgentLifecycleState.Failed,
    AgentLifecycleState.Disabled,
    AgentLifecycleState.Terminated,
  ],
  [AgentLifecycleState.Running]: [
    AgentLifecycleState.Ready,
    AgentLifecycleState.Draining,
    AgentLifecycleState.Failed,
    AgentLifecycleState.Terminated,
  ],
  [AgentLifecycleState.Draining]: [
    AgentLifecycleState.Disabled,
    AgentLifecycleState.Failed,
    AgentLifecycleState.Terminated,
  ],
  [AgentLifecycleState.Paused]: [
    AgentLifecycleState.Ready,
    AgentLifecycleState.Failed,
    AgentLifecycleState.Disabled,
    AgentLifecycleState.Terminated,
  ],
  [AgentLifecycleState.Disabled]: [
    AgentLifecycleState.Initializing,
    AgentLifecycleState.Terminated,
  ],
  [AgentLifecycleState.Failed]: [AgentLifecycleState.Initializing, AgentLifecycleState.Terminated],
  [AgentLifecycleState.Terminated]: [],
};

/** A single resolved transition. */
export interface AgentLifecycleTransition {
  readonly from: AgentLifecycleState;
  readonly to: AgentLifecycleState;
}

/** Pure, single-agent lifecycle state machine. */
export class AgentLifecycleStateMachine {
  private state: AgentLifecycleState;

  constructor(initial: AgentLifecycleState = AgentLifecycleState.Registered) {
    this.state = initial;
  }

  get current(): AgentLifecycleState {
    return this.state;
  }

  canTransition(to: AgentLifecycleState): boolean {
    return TRANSITIONS[this.state].includes(to);
  }

  /** Attempts the transition; throws on invalid transitions. */
  transition(to: AgentLifecycleState): AgentLifecycleTransition {
    if (!this.canTransition(to)) {
      throw new AgentLifecycleInvalidError(
        `Invalid agent lifecycle transition: ${this.state} -> ${to}`,
        { from: this.state, to },
      );
    }
    const transition: AgentLifecycleTransition = { from: this.state, to };
    this.state = to;
    return transition;
  }
}

/** Options for the lifecycle controller. */
export interface AgentLifecycleControllerOptions {
  readonly eventLog?: AgentPlatformEventLog;
  readonly metrics?: AgentPlatformMetrics;
  readonly now?: () => IsoTimestamp;
}

/** Per-agent runtime state (single-threaded Node: no locks needed). */
interface AgentRuntimeState {
  readonly machine: AgentLifecycleStateMachine;
  active: number;
}

/**
 * Concurrency-safe lifecycle controller (Sprint 19 §12/§13/§26).
 *
 * All operations are synchronous and bounded so concurrent `await` calls
 * serialize deterministically. Active execution counts can never go negative,
 * and draining auto-disables once active executions reach zero.
 */
export class AgentLifecycleController {
  private readonly agents = new Map<AgentId, AgentRuntimeState>();
  private readonly eventLog?: AgentPlatformEventLog;
  private readonly metrics?: AgentPlatformMetrics;
  private readonly now: () => IsoTimestamp;

  constructor(options: AgentLifecycleControllerOptions = {}) {
    this.eventLog = options.eventLog;
    this.metrics = options.metrics;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  // -------------------------------------------------------------------------
  // Inspection
  // -------------------------------------------------------------------------

  registeredIds(): readonly AgentId[] {
    return [...this.agents.keys()];
  }

  stateOf(agentId: AgentId): AgentLifecycleState | undefined {
    return this.agents.get(agentId)?.machine.current;
  }

  isRegistered(agentId: AgentId): boolean {
    return this.agents.has(agentId);
  }

  isReady(agentId: AgentId): boolean {
    const state = this.stateOf(agentId);
    return state === AgentLifecycleState.Ready || state === AgentLifecycleState.Running;
  }

  /** Whether routing may consider this agent (READY or RUNNING). */
  isRoutable(agentId: AgentId): boolean {
    return this.isReady(agentId);
  }

  activeExecutionCount(agentId: AgentId): number {
    return this.agents.get(agentId)?.active ?? 0;
  }

  totalActiveExecutions(): number {
    let total = 0;
    for (const state of this.agents.values()) {
      total += state.active;
    }
    return total;
  }

  /** Deterministic per-state counts and in-flight executions. */
  summary(): AgentLifecycleSummary {
    const states: Record<AgentLifecycleState, number> = {
      [AgentLifecycleState.Registered]: 0,
      [AgentLifecycleState.Initializing]: 0,
      [AgentLifecycleState.Ready]: 0,
      [AgentLifecycleState.Running]: 0,
      [AgentLifecycleState.Draining]: 0,
      [AgentLifecycleState.Paused]: 0,
      [AgentLifecycleState.Disabled]: 0,
      [AgentLifecycleState.Failed]: 0,
      [AgentLifecycleState.Terminated]: 0,
    };
    for (const entry of this.agents.values()) {
      states[entry.machine.current] += 1;
    }
    return { states, activeExecutions: this.totalActiveExecutions() };
  }

  // -------------------------------------------------------------------------
  // Lifecycle operations
  // -------------------------------------------------------------------------

  register(agentId: AgentId): void {
    if (this.agents.has(agentId)) {
      throw new AgentAlreadyRegisteredError(`Agent ${agentId} is already registered`);
    }
    this.agents.set(agentId, { machine: new AgentLifecycleStateMachine(), active: 0 });
    this.emit(agentRegisteredEvent, { agentId, lifecycleState: AgentLifecycleState.Registered });
  }

  /** Registered → Initializing. */
  initialize(agentId: AgentId): void {
    this.transition(agentId, AgentLifecycleState.Initializing, () =>
      this.emit(agentInitializingEvent, {
        agentId,
        lifecycleState: AgentLifecycleState.Initializing,
      }),
    );
  }

  /**
   * Initializing/Registered → Ready (idempotent when already Ready/Running).
   * Driving `activate()` from Registered performs the documented
   * REGISTERED → INITIALIZING → READY sequence in one call.
   */
  activate(agentId: AgentId): void {
    const state = this.require(agentId).machine.current;
    if (state === AgentLifecycleState.Ready || state === AgentLifecycleState.Running) {
      return;
    }
    if (state === AgentLifecycleState.Registered) {
      this.initialize(agentId);
      this.activate2Ready(agentId);
      return;
    }
    this.activate2Ready(agentId);
  }

  private activate2Ready(agentId: AgentId): void {
    const entry = this.require(agentId);
    if (entry.machine.current === AgentLifecycleState.Initializing) {
      this.transition(agentId, AgentLifecycleState.Ready, noop);
      this.emit(agentReadyEvent, { agentId, lifecycleState: AgentLifecycleState.Ready });
      return;
    }
    if (entry.machine.current === AgentLifecycleState.Ready) {
      return;
    }
    throw new AgentLifecycleInvalidError(
      `Cannot activate agent ${agentId} from state ${entry.machine.current}`,
      { agentId, state: entry.machine.current },
    );
  }

  /** Ready/Running → Paused (idempotent when already Paused). */
  pause(agentId: AgentId): void {
    const entry = this.require(agentId);
    if (entry.machine.current === AgentLifecycleState.Paused) {
      return;
    }
    this.transition(agentId, AgentLifecycleState.Paused, () =>
      this.emit(agentPausedEvent, { agentId, lifecycleState: AgentLifecycleState.Paused }),
    );
  }

  /** Paused → Ready (idempotent when already Ready/Running). */
  resume(agentId: AgentId): void {
    const entry = this.require(agentId);
    if (
      entry.machine.current === AgentLifecycleState.Ready ||
      entry.machine.current === AgentLifecycleState.Running
    ) {
      return;
    }
    this.transition(agentId, AgentLifecycleState.Ready, () =>
      this.emit(agentResumedEvent, { agentId, lifecycleState: AgentLifecycleState.Ready }),
    );
  }

  /** Ready/Running → Draining. Idempotent while already draining. */
  drain(agentId: AgentId): void {
    const entry = this.require(agentId);
    if (entry.machine.current === AgentLifecycleState.Draining) {
      return;
    }
    this.transition(agentId, AgentLifecycleState.Draining, () =>
      this.emit(agentDrainingEvent, { agentId, lifecycleState: AgentLifecycleState.Draining }),
    );
    if (entry.active === 0) {
      this.disable(agentId);
    }
  }

  /** Draining/Ready/Paused/… → Disabled. Idempotent when already disabled. */
  disable(agentId: AgentId): void {
    const entry = this.require(agentId);
    const state = entry.machine.current;
    if (state === AgentLifecycleState.Disabled) {
      return;
    }
    if (state === AgentLifecycleState.Draining || state === AgentLifecycleState.Running) {
      if (entry.active > 0) {
        throw new AgentLifecycleInvalidError(
          `Cannot disable agent ${agentId}: it is still ${state} with ${entry.active} active executions`,
          { agentId, state, active: entry.active },
        );
      }
    }
    this.transition(agentId, AgentLifecycleState.Disabled, () =>
      this.emit(agentDisabledEvent, { agentId, lifecycleState: AgentLifecycleState.Disabled }),
    );
  }

  /** Ready/Running → Failed (operator mark; recover() can return to init). */
  fail(agentId: AgentId): void {
    this.transition(agentId, AgentLifecycleState.Failed, () =>
      this.emit(agentFailedEvent, { agentId, lifecycleState: AgentLifecycleState.Failed }),
    );
  }

  /** Failed/Disabled → Initializing (recovery path; then activate()). */
  recover(agentId: AgentId): void {
    const entry = this.require(agentId);
    if (
      entry.machine.current !== AgentLifecycleState.Failed &&
      entry.machine.current !== AgentLifecycleState.Disabled
    ) {
      throw new AgentLifecycleInvalidError(
        `Cannot recover agent ${agentId} from state ${entry.machine.current}`,
        { agentId, state: entry.machine.current },
      );
    }
    this.transition(agentId, AgentLifecycleState.Initializing, () =>
      this.emit(agentRecoveredEvent, {
        agentId,
        lifecycleState: AgentLifecycleState.Initializing,
      }),
    );
  }

  /** Any non-executing state → Terminated (final). */
  terminate(agentId: AgentId): void {
    const entry = this.require(agentId);
    if (entry.active > 0) {
      throw new AgentLifecycleInvalidError(
        `Cannot terminate agent ${agentId}: it has ${entry.active} active executions (drain first)`,
        { agentId, active: entry.active },
      );
    }
    this.transition(agentId, AgentLifecycleState.Terminated, () =>
      this.emit(agentTerminatedEvent, { agentId, lifecycleState: AgentLifecycleState.Terminated }),
    );
  }

  // -------------------------------------------------------------------------
  // Execution gates (Sprint 19 §13/§18)
  // -------------------------------------------------------------------------

  /**
   * Reserves an execution slot. Only READY/RUNNING agents may accept new work;
   * PAUSED, DRAINING, DISABLED, FAILED and TERMINATED agents reject with
   * normalized errors. Setting RUNNING here is the single source of truth.
   */
  beginExecution(agentId: AgentId): void {
    const entry = this.require(agentId);
    const state = entry.machine.current;
    if (state === AgentLifecycleState.Disabled) {
      throw new AgentDisabledError(`Agent ${agentId} is disabled`);
    }
    if (state === AgentLifecycleState.Terminated) {
      throw new AgentTerminatedError(`Agent ${agentId} is terminated`);
    }
    if (state !== AgentLifecycleState.Ready && state !== AgentLifecycleState.Running) {
      throw new AgentNotReadyError(`Agent ${agentId} is ${state} and cannot start new executions`, {
        agentId,
        state,
      });
    }
    this.markRunning(entry, agentId);
  }

  /** Releases an execution slot; never negative. Auto-transitions on zero. */
  endExecution(agentId: AgentId): void {
    const entry = this.agents.get(agentId);
    if (entry === undefined) {
      return;
    }
    entry.active = Math.max(0, entry.active - 1);
    const state = entry.machine.current;
    if (entry.active === 0) {
      if (state === AgentLifecycleState.Draining) {
        this.disable(agentId);
      } else if (state === AgentLifecycleState.Running) {
        this.forceTransition(entry, AgentLifecycleState.Ready);
        this.emit(agentReadyEvent, {
          agentId,
          lifecycleState: AgentLifecycleState.Ready,
          previousState: AgentLifecycleState.Running,
        });
      }
    }
  }

  private markRunning(entry: AgentRuntimeState, agentId: AgentId): void {
    if (entry.machine.current !== AgentLifecycleState.Running) {
      this.forceTransition(entry, AgentLifecycleState.Running);
      this.emit(agentStartedEvent, {
        agentId,
        lifecycleState: AgentLifecycleState.Running,
        previousState: AgentLifecycleState.Ready,
      });
    }
    entry.active += 1;
  }

  /** Removes all state (used by unregister after confirming zero active). */
  unregister(agentId: AgentId): boolean {
    const entry = this.agents.get(agentId);
    if (entry === undefined) {
      return false;
    }
    if (entry.active > 0) {
      throw new AgentLifecycleInvalidError(
        `Cannot unregister agent ${agentId}: ${entry.active} active executions`,
        { agentId, active: entry.active },
      );
    }
    this.agents.delete(agentId);
    return true;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private require(agentId: AgentId): AgentRuntimeState {
    const entry = this.agents.get(agentId);
    if (entry === undefined) {
      throw new AgentNotReadyError(`Agent ${agentId} is not registered`, { agentId });
    }
    return entry;
  }

  private transition(agentId: AgentId, to: AgentLifecycleState, onSuccess: () => void): void {
    const entry = this.require(agentId);
    entry.machine.transition(to);
    this.metrics?.recordLifecycleTransition();
    onSuccess();
  }

  private forceTransition(entry: AgentRuntimeState, to: AgentLifecycleState): void {
    entry.machine.transition(to);
    this.metrics?.recordLifecycleTransition();
  }

  private emit(
    factory: (input: {
      readonly occurredAt: string;
      readonly agentId?: string;
      readonly lifecycleState?: string;
      readonly previousState?: string;
    }) => AgentPlatformEvent,
    input: {
      readonly agentId: string;
      readonly lifecycleState: string;
      readonly previousState?: string;
    },
  ): void {
    if (this.eventLog === undefined) {
      return;
    }
    try {
      this.eventLog.append(factory({ occurredAt: this.now(), ...input }));
    } catch {
      // Observability must never affect lifecycle correctness.
    }
  }
}
