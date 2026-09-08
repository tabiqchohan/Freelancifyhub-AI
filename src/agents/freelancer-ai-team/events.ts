/**
 * Sprint 22 — Freelancer AI Team v1. Observable events.
 *
 * Safe, append-only audit of freelancer-AI request lifecycle: selection,
 * memory/knowledge access, tool use, and terminal outcomes. Events never carry
 * secrets, database URLs, prompts, chain-of-thought, or raw payloads — only
 * identifiers, statuses and reason codes.
 */

/** Typed freelancer-AI event kinds. */
export type FreelancerAIEventType =
  | 'FREELANCER_WORKFLOW_SELECTED'
  | 'FREELANCER_WORKFLOW_STARTED'
  | 'FREELANCER_WORKFLOW_COMPLETED'
  | 'FREELANCER_WORKFLOW_FAILED'
  | 'FREELANCER_WORKFLOW_CANCELLED'
  | 'FREELANCER_WORKFLOW_TIMEOUT'
  | 'FREELANCER_AGENT_STARTED'
  | 'FREELANCER_AGENT_COMPLETED'
  | 'FREELANCER_AGENT_FAILED'
  | 'FREELANCER_AGENT_SKIPPED'
  | 'FREELANCER_RECOMMENDATION_GENERATED'
  | 'FREELANCER_MEMORY_ACCESSED'
  | 'FREELANCER_KNOWLEDGE_ACCESSED'
  | 'FREELANCER_TOOL_USED';

/** Severity of a freelancer-AI event. */
export type FreelancerAIEventSeverity = 'info' | 'warning' | 'error';

/** Safe metadata attached to a freelancer-AI event (never payloads). */
export interface FreelancerAIEventMetadata {
  readonly freelancerRequestId?: string;
  readonly correlationId?: string;
  readonly traceId?: string;
  readonly requestId?: string;
  readonly agentId?: string;
  readonly capabilityId?: string;
  readonly taskId?: string;
  readonly workflowId?: string;
  readonly coordinationId?: string;
  readonly status?: string;
  readonly reasonCode?: string;
  readonly routeKind?: string;
  readonly intent?: string;
  readonly count?: number;
}

/** A freelancer-AI event before identity/sequence resolution. */
export interface FreelancerAIEventInput {
  readonly type: FreelancerAIEventType;
  readonly occurredAt: string;
  readonly success?: boolean;
  readonly metadata?: FreelancerAIEventMetadata;
}

/** A fully resolved, immutable stored freelancer-AI event. */
export interface StoredFreelancerAIEvent {
  readonly eventId: string;
  readonly type: FreelancerAIEventType;
  readonly category: 'freelancer';
  readonly severity: FreelancerAIEventSeverity;
  readonly occurredAt: string;
  readonly sequence: number;
  readonly success?: boolean;
  readonly metadata?: FreelancerAIEventMetadata;
}

/** Options for the freelancer-AI event log. */
export interface FreelancerAIEventLogOptions {
  readonly eventIdFactory?: () => string;
}

/** The freelancer-AI event log (append-only, deterministic ordering). */
export class FreelancerAIEventLog {
  readonly name = 'freelancer-ai-event-log';

  private readonly events: StoredFreelancerAIEvent[] = [];
  private readonly eventIdFactory: () => string;

  constructor(options: FreelancerAIEventLogOptions = {}) {
    this.eventIdFactory =
      options.eventIdFactory ?? (() => `evt_freelancer_${this.events.length + 1}`);
  }

  /** Appends a resolved event and returns it. */
  append(input: FreelancerAIEventInput): StoredFreelancerAIEvent {
    const event: StoredFreelancerAIEvent = {
      eventId: this.eventIdFactory(),
      type: input.type,
      category: 'freelancer',
      severity: severityFor(input),
      occurredAt: input.occurredAt,
      sequence: this.events.length + 1,
      success: input.success,
      metadata: input.metadata,
    };
    this.events.push(event);
    return event;
  }

  /** All stored events, in append order. */
  query(): readonly StoredFreelancerAIEvent[] {
    return Object.freeze([...this.events]);
  }

  /** Number of stored events. */
  count(): number {
    return this.events.length;
  }

  /** Most recent stored event (undefined when empty). */
  latest(): StoredFreelancerAIEvent | undefined {
    return this.events.length > 0 ? this.events[this.events.length - 1] : undefined;
  }

  /** Events of a single type, in append order. */
  ofType(type: FreelancerAIEventType): readonly StoredFreelancerAIEvent[] {
    return Object.freeze(this.events.filter((event) => event.type === type));
  }
}

function severityFor(input: FreelancerAIEventInput): FreelancerAIEventSeverity {
  if (input.success === false) {
    return 'error';
  }
  if (
    input.type === 'FREELANCER_WORKFLOW_CANCELLED' ||
    input.type === 'FREELANCER_WORKFLOW_TIMEOUT'
  ) {
    return 'warning';
  }
  return 'info';
}
