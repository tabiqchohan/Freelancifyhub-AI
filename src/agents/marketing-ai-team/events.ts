/**
 * Sprint 24 — Marketing AI Team v1. Observable events.
 *
 * Safe, append-only audit of marketing-AI request lifecycle: selection,
 * memory/knowledge access, tool use, insufficient-data reports, and terminal
 * outcomes. Events never carry secrets, database URLs, prompts,
 * chain-of-thought, or raw payloads — only identifiers, statuses and reason
 * codes.
 */

/** Typed marketing-AI event kinds. */
export type MarketingAIEventType =
  | 'MARKETING_WORKFLOW_SELECTED'
  | 'MARKETING_WORKFLOW_STARTED'
  | 'MARKETING_WORKFLOW_COMPLETED'
  | 'MARKETING_WORKFLOW_FAILED'
  | 'MARKETING_WORKFLOW_CANCELLED'
  | 'MARKETING_WORKFLOW_TIMEOUT'
  | 'MARKETING_AGENT_STARTED'
  | 'MARKETING_AGENT_COMPLETED'
  | 'MARKETING_AGENT_FAILED'
  | 'MARKETING_AGENT_SKIPPED'
  | 'MARKETING_RECOMMENDATION_GENERATED'
  | 'MARKETING_MEMORY_ACCESSED'
  | 'MARKETING_KNOWLEDGE_ACCESSED'
  | 'MARKETING_TOOL_USED'
  | 'MARKETING_INSUFFICIENT_DATA';

/** Severity of a marketing-AI event. */
export type MarketingAIEventSeverity = 'info' | 'warning' | 'error';

/** Safe metadata attached to a marketing-AI event (never payloads). */
export interface MarketingAIEventMetadata {
  readonly marketingRequestId?: string;
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

/** A marketing-AI event before identity/sequence resolution. */
export interface MarketingAIEventInput {
  readonly type: MarketingAIEventType;
  readonly occurredAt: string;
  readonly success?: boolean;
  readonly metadata?: MarketingAIEventMetadata;
}

/** A fully resolved, immutable stored marketing-AI event. */
export interface StoredMarketingAIEvent {
  readonly eventId: string;
  readonly type: MarketingAIEventType;
  readonly category: 'marketing';
  readonly severity: MarketingAIEventSeverity;
  readonly occurredAt: string;
  readonly sequence: number;
  readonly success?: boolean;
  readonly metadata?: MarketingAIEventMetadata;
}

/** Options for the marketing-AI event log. */
export interface MarketingAIEventLogOptions {
  readonly eventIdFactory?: () => string;
}

/** The marketing-AI event log (append-only, deterministic ordering). */
export class MarketingAIEventLog {
  readonly name = 'marketing-ai-event-log';

  private readonly events: StoredMarketingAIEvent[] = [];
  private readonly eventIdFactory: () => string;

  constructor(options: MarketingAIEventLogOptions = {}) {
    this.eventIdFactory =
      options.eventIdFactory ?? (() => `evt_marketing_${this.events.length + 1}`);
  }

  /** Appends a resolved event and returns it. */
  append(input: MarketingAIEventInput): StoredMarketingAIEvent {
    const event: StoredMarketingAIEvent = {
      eventId: this.eventIdFactory(),
      type: input.type,
      category: 'marketing',
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
  query(): readonly StoredMarketingAIEvent[] {
    return Object.freeze([...this.events]);
  }

  /** Number of stored events. */
  count(): number {
    return this.events.length;
  }

  /** Most recent stored event (undefined when empty). */
  latest(): StoredMarketingAIEvent | undefined {
    return this.events.length > 0 ? this.events[this.events.length - 1] : undefined;
  }

  /** Events of a single type, in append order. */
  ofType(type: MarketingAIEventType): readonly StoredMarketingAIEvent[] {
    return Object.freeze(this.events.filter((event) => event.type === type));
  }
}

function severityFor(input: MarketingAIEventInput): MarketingAIEventSeverity {
  if (input.success === false) {
    return 'error';
  }
  if (
    input.type === 'MARKETING_WORKFLOW_CANCELLED' ||
    input.type === 'MARKETING_WORKFLOW_TIMEOUT' ||
    input.type === 'MARKETING_INSUFFICIENT_DATA'
  ) {
    return 'warning';
  }
  return 'info';
}
