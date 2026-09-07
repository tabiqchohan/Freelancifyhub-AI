/**
 * Sprint 20 — Multi-Agent Coordination & Collaboration. Observable events.
 *
 * Safe, append-only audit of coordination lifecycle, task state transitions,
 * agent selection, conflicts, and terminal outcomes. Events never carry
 * secrets, credentials, database URLs, private prompts, chain-of-thought, or
 * raw sensitive payloads — only identifiers, statuses, and reason codes.
 */

import {
  type CoordinationMode,
  type CoordinationPhase,
  type CoordinationStatus,
  type TaskStatus,
} from './types.js';

/** Coordination event categories. */
export type CoordinationEventCategory = 'coordination' | 'task' | 'policy';

/** Typed coordination event kinds (Sprint 20 §26). */
export type CoordinationEventType =
  | 'COORDINATION_CREATED'
  | 'COORDINATION_STARTED'
  | 'TASK_CREATED'
  | 'TASK_READY'
  | 'TASK_STARTED'
  | 'TASK_COMPLETED'
  | 'TASK_FAILED'
  | 'TASK_CANCELLED'
  | 'TASK_TIMED_OUT'
  | 'TASK_RETRYING'
  | 'AGENT_SELECTED'
  | 'AGENT_REJECTED'
  | 'RESULT_RECEIVED'
  | 'CONFLICT_DETECTED'
  | 'COORDINATION_CANCELLED'
  | 'COORDINATION_COMPLETED'
  | 'COORDINATION_FAILED';

/** Severity of a coordination event. */
export type CoordinationEventSeverity = 'info' | 'warning' | 'error';

/** Safe metadata for a coordination event (never payloads). */
export interface CoordinationEventMetadata {
  readonly coordinationId?: string;
  readonly taskId?: string;
  readonly agentId?: string;
  readonly mode?: CoordinationMode;
  readonly status?: string;
  readonly phase?: CoordinationPhase;
  readonly reasonCode?: string;
  readonly parentExecutionId?: string;
  readonly correlationId?: string;
}

/** A coordination event before identity/sequence resolution. */
export interface CoordinationEvent {
  readonly eventId?: string;
  readonly type: CoordinationEventType;
  readonly occurredAt: string;
  readonly success?: boolean;
  readonly metadata?: CoordinationEventMetadata;
}

/** A fully resolved, immutable stored coordination event. */
export interface StoredCoordinationEvent {
  readonly eventId: string;
  readonly type: CoordinationEventType;
  readonly category: CoordinationEventCategory;
  readonly severity: CoordinationEventSeverity;
  readonly occurredAt: string;
  readonly sequence: number;
  readonly success?: boolean;
  readonly metadata?: CoordinationEventMetadata;
}

/** Options for the coordination event log. */
export interface CoordinationEventLogOptions {
  readonly maxPageSize?: number;
  readonly eventIdFactory?: () => string;
}

/** Query filter for the coordination event log. */
export interface CoordinationEventFilter {
  readonly type?: CoordinationEventType;
  readonly category?: CoordinationEventCategory;
  readonly coordinationId?: string;
  readonly agentId?: string;
  readonly success?: boolean;
}

/** Deterministic, append-only in-memory coordination event log. */
export class CoordinationEventLog {
  readonly name = 'coordination-event-log';
  readonly backend = 'in-memory';

  private readonly maxPageSize: number;
  private readonly eventIdFactory: () => string;
  private readonly stored: StoredCoordinationEvent[] = [];
  private readonly byId = new Map<string, StoredCoordinationEvent>();
  private nextSequence = 0;

  constructor(options: CoordinationEventLogOptions = {}) {
    this.maxPageSize = options.maxPageSize ?? 50;
    this.eventIdFactory = options.eventIdFactory ?? defaultCoordinationEventIdFactory;
  }

  append(event: CoordinationEvent): StoredCoordinationEvent {
    if (!event.type || !event.occurredAt) {
      throw new Error('Coordination event missing required fields');
    }
    const eventId = event.eventId ?? this.eventIdFactory();
    if (this.byId.has(eventId)) {
      throw new Error(`Duplicate coordination event id: ${eventId}`);
    }
    const stored: StoredCoordinationEvent = {
      eventId,
      type: event.type,
      category: categoryFor(event.type),
      severity: severityFor(event.type),
      occurredAt: event.occurredAt,
      sequence: this.nextSequence,
      success: event.success,
      metadata: event.metadata,
    };
    this.stored.push(stored);
    this.byId.set(eventId, stored);
    this.nextSequence += 1;
    return stored;
  }

  getById(eventId: string): StoredCoordinationEvent | undefined {
    return this.byId.get(eventId);
  }

  query(filter: CoordinationEventFilter = {}): readonly StoredCoordinationEvent[] {
    return this.stored.filter((event) => matches(event, filter));
  }

  count(filter?: CoordinationEventFilter): number {
    if (filter === undefined) {
      return this.stored.length;
    }
    return this.stored.filter((event) => matches(event, filter)).length;
  }

  latest(limit = 10): readonly StoredCoordinationEvent[] {
    const resolved = Math.max(1, Math.min(Math.abs(limit), Math.max(1, this.maxPageSize)));
    return this.stored.slice(Math.max(0, this.stored.length - resolved)).reverse();
  }

  clear(): void {
    this.stored.length = 0;
    this.byId.clear();
    this.nextSequence = 0;
  }
}

function matches(event: StoredCoordinationEvent, filter: CoordinationEventFilter): boolean {
  if (filter.type !== undefined && event.type !== filter.type) {
    return false;
  }
  if (filter.category !== undefined && event.category !== filter.category) {
    return false;
  }
  if (
    filter.coordinationId !== undefined &&
    event.metadata?.coordinationId !== filter.coordinationId
  ) {
    return false;
  }
  if (filter.agentId !== undefined && event.metadata?.agentId !== filter.agentId) {
    return false;
  }
  if (filter.success !== undefined && event.success !== filter.success) {
    return false;
  }
  return true;
}

function categoryFor(type: CoordinationEventType): CoordinationEventCategory {
  if (type.startsWith('TASK_')) {
    return 'task';
  }
  if (type === 'AGENT_SELECTED' || type === 'AGENT_REJECTED' || type === 'CONFLICT_DETECTED') {
    return 'policy';
  }
  return 'coordination';
}

function severityFor(type: CoordinationEventType): CoordinationEventSeverity {
  switch (type) {
    case 'TASK_FAILED':
    case 'AGENT_REJECTED':
    case 'COORDINATION_FAILED':
      return 'error';
    case 'TASK_CANCELLED':
    case 'TASK_TIMED_OUT':
    case 'TASK_RETRYING':
    case 'CONFLICT_DETECTED':
    case 'COORDINATION_CANCELLED':
      return 'warning';
    default:
      return 'info';
  }
}

function defaultCoordinationEventIdFactory(): string {
  return `cev_${randomId()}`;
}

function randomId(): string {
  if (typeof globalThis.crypto !== 'undefined' && 'randomUUID' in globalThis.crypto) {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/** Safe metadata input for event factories. */
export interface CoordinationEventInput {
  readonly occurredAt: string;
  readonly coordinationId?: string;
  readonly taskId?: string;
  readonly agentId?: string;
  readonly mode?: CoordinationMode;
  readonly status?: string;
  readonly phase?: CoordinationPhase;
  readonly reasonCode?: string;
  readonly parentExecutionId?: string;
  readonly correlationId?: string;
}

function eventFor(
  type: CoordinationEventType,
  input: CoordinationEventInput,
  success?: boolean,
): CoordinationEvent {
  const metadata: CoordinationEventMetadata = {
    coordinationId: input.coordinationId,
    taskId: input.taskId,
    agentId: input.agentId,
    mode: input.mode,
    status: input.status,
    phase: input.phase,
    reasonCode: input.reasonCode,
    parentExecutionId: input.parentExecutionId,
    correlationId: input.correlationId,
  };
  const clean: Record<string, unknown> = {};
  for (const key of Object.keys(metadata) as (keyof CoordinationEventMetadata)[]) {
    const value = metadata[key];
    if (value !== undefined) {
      clean[key] = value;
    }
  }
  return {
    type,
    occurredAt: input.occurredAt,
    success,
    metadata: clean as CoordinationEventMetadata,
  };
}

/** Record: a coordination was created from a validated plan. */
export function coordinationCreatedEvent(input: CoordinationEventInput): CoordinationEvent {
  return eventFor('COORDINATION_CREATED', input, true);
}

/** Record: a coordination started dispatching. */
export function coordinationStartedEvent(input: CoordinationEventInput): CoordinationEvent {
  return eventFor('COORDINATION_STARTED', input, true);
}

/** Record: a task was created in the plan. */
export function taskCreatedEvent(input: CoordinationEventInput): CoordinationEvent {
  return eventFor('TASK_CREATED', input, true);
}

/** Record: a task became ready (dependencies satisfied). */
export function taskReadyEvent(input: CoordinationEventInput): CoordinationEvent {
  return eventFor('TASK_READY', input, true);
}

/** Record: a task started running. */
export function taskStartedEvent(input: CoordinationEventInput): CoordinationEvent {
  return eventFor('TASK_STARTED', input, true);
}

/** Record: a task completed successfully. */
export function taskCompletedEvent(input: CoordinationEventInput): CoordinationEvent {
  return eventFor('TASK_COMPLETED', input, true);
}

/** Record: a task failed. */
export function taskFailedEvent(input: CoordinationEventInput): CoordinationEvent {
  return eventFor('TASK_FAILED', input, false);
}

/** Record: a task was cancelled. */
export function taskCancelledEvent(input: CoordinationEventInput): CoordinationEvent {
  return eventFor('TASK_CANCELLED', input, false);
}

/** Record: a task timed out. */
export function taskTimedOutEvent(input: CoordinationEventInput): CoordinationEvent {
  return eventFor('TASK_TIMED_OUT', input, false);
}

/** Record: a task is being retried. */
export function taskRetryingEvent(input: CoordinationEventInput): CoordinationEvent {
  return eventFor('TASK_RETRYING', input);
}

/** Record: an agent was selected for a task. */
export function agentSelectedEvent(input: CoordinationEventInput): CoordinationEvent {
  return eventFor('AGENT_SELECTED', input, true);
}

/** Record: an agent was rejected for a task. */
export function agentRejectedEvent(input: CoordinationEventInput): CoordinationEvent {
  return eventFor('AGENT_REJECTED', input, false);
}

/** Record: a task result was received by the collector. */
export function resultReceivedEvent(input: CoordinationEventInput): CoordinationEvent {
  return eventFor('RESULT_RECEIVED', input, true);
}

/** Record: a conflict was detected during aggregation. */
export function conflictDetectedEvent(input: CoordinationEventInput): CoordinationEvent {
  return eventFor('CONFLICT_DETECTED', input, false);
}

/** Record: a coordination was cancelled. */
export function coordinationCancelledEvent(input: CoordinationEventInput): CoordinationEvent {
  return eventFor('COORDINATION_CANCELLED', input, false);
}

/** Record: a coordination completed (fully or partially). */
export function coordinationCompletedEvent(input: CoordinationEventInput): CoordinationEvent {
  return eventFor('COORDINATION_COMPLETED', input, true);
}

/** Record: a coordination failed. */
export function coordinationFailedEvent(input: CoordinationEventInput): CoordinationEvent {
  return eventFor('COORDINATION_FAILED', input, false);
}

/** utility re-export so consumers can read task statuses from events. */
export type { CoordinationStatus, TaskStatus };
