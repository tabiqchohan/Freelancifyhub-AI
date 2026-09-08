/**
 * Sprint 23 — Marketplace AI Team v1. Observable events.
 *
 * Safe, append-only audit of marketplace-AI request lifecycle: selection,
 * memory/knowledge access, tool use, insufficient-data reports, and terminal
 * outcomes. Events never carry secrets, database URLs, prompts,
 * chain-of-thought, or raw payloads — only identifiers, statuses and reason
 * codes.
 */

/** Typed marketplace-AI event kinds. */
export type MarketplaceAIEventType =
  | 'MARKETPLACE_WORKFLOW_SELECTED'
  | 'MARKETPLACE_WORKFLOW_STARTED'
  | 'MARKETPLACE_WORKFLOW_COMPLETED'
  | 'MARKETPLACE_WORKFLOW_FAILED'
  | 'MARKETPLACE_WORKFLOW_CANCELLED'
  | 'MARKETPLACE_WORKFLOW_TIMEOUT'
  | 'MARKETPLACE_AGENT_STARTED'
  | 'MARKETPLACE_AGENT_COMPLETED'
  | 'MARKETPLACE_AGENT_FAILED'
  | 'MARKETPLACE_AGENT_SKIPPED'
  | 'MARKETPLACE_RECOMMENDATION_GENERATED'
  | 'MARKETPLACE_MEMORY_ACCESSED'
  | 'MARKETPLACE_KNOWLEDGE_ACCESSED'
  | 'MARKETPLACE_TOOL_USED'
  | 'MARKETPLACE_INSUFFICIENT_DATA';

/** Severity of a marketplace-AI event. */
export type MarketplaceAIEventSeverity = 'info' | 'warning' | 'error';

/** Safe metadata attached to a marketplace-AI event (never payloads). */
export interface MarketplaceAIEventMetadata {
  readonly marketplaceRequestId?: string;
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

/** A marketplace-AI event before identity/sequence resolution. */
export interface MarketplaceAIEventInput {
  readonly type: MarketplaceAIEventType;
  readonly occurredAt: string;
  readonly success?: boolean;
  readonly metadata?: MarketplaceAIEventMetadata;
}

/** A fully resolved, immutable stored marketplace-AI event. */
export interface StoredMarketplaceAIEvent {
  readonly eventId: string;
  readonly type: MarketplaceAIEventType;
  readonly category: 'marketplace';
  readonly severity: MarketplaceAIEventSeverity;
  readonly occurredAt: string;
  readonly sequence: number;
  readonly success?: boolean;
  readonly metadata?: MarketplaceAIEventMetadata;
}

/** Options for the marketplace-AI event log. */
export interface MarketplaceAIEventLogOptions {
  readonly eventIdFactory?: () => string;
}

/** The marketplace-AI event log (append-only, deterministic ordering). */
export class MarketplaceAIEventLog {
  readonly name = 'marketplace-ai-event-log';

  private readonly events: StoredMarketplaceAIEvent[] = [];
  private readonly eventIdFactory: () => string;

  constructor(options: MarketplaceAIEventLogOptions = {}) {
    this.eventIdFactory =
      options.eventIdFactory ?? (() => `evt_marketplace_${this.events.length + 1}`);
  }

  /** Appends a resolved event and returns it. */
  append(input: MarketplaceAIEventInput): StoredMarketplaceAIEvent {
    const event: StoredMarketplaceAIEvent = {
      eventId: this.eventIdFactory(),
      type: input.type,
      category: 'marketplace',
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
  query(): readonly StoredMarketplaceAIEvent[] {
    return Object.freeze([...this.events]);
  }

  /** Number of stored events. */
  count(): number {
    return this.events.length;
  }

  /** Most recent stored event (undefined when empty). */
  latest(): StoredMarketplaceAIEvent | undefined {
    return this.events.length > 0 ? this.events[this.events.length - 1] : undefined;
  }

  /** Events of a single type, in append order. */
  ofType(type: MarketplaceAIEventType): readonly StoredMarketplaceAIEvent[] {
    return Object.freeze(this.events.filter((event) => event.type === type));
  }
}

function severityFor(input: MarketplaceAIEventInput): MarketplaceAIEventSeverity {
  if (input.success === false) {
    return 'error';
  }
  if (
    input.type === 'MARKETPLACE_WORKFLOW_CANCELLED' ||
    input.type === 'MARKETPLACE_WORKFLOW_TIMEOUT' ||
    input.type === 'MARKETPLACE_INSUFFICIENT_DATA'
  ) {
    return 'warning';
  }
  return 'info';
}
