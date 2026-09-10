/**
 * Sprint 25 — Admin AI Team v1. Observable events & privileged audit trail.
 *
 * Safe, append-only audit of admin-AI request lifecycle: authorization
 * decisions, workflow selection, memory/knowledge access, tool use,
 * approval-gated recommendations, insufficient-data reports, and terminal
 * outcomes. Events never carry secrets, database URLs, prompts,
 * chain-of-thought, platform data or raw payloads — only identifiers,
 * statuses and reason codes (BR-ADM-3: the audit trail itself never leaks).
 */

/** Typed admin-AI event kinds. */
export type AdminAIEventType =
  | 'ADMIN_WORKFLOW_SELECTED'
  | 'ADMIN_WORKFLOW_STARTED'
  | 'ADMIN_WORKFLOW_COMPLETED'
  | 'ADMIN_WORKFLOW_FAILED'
  | 'ADMIN_WORKFLOW_CANCELLED'
  | 'ADMIN_WORKFLOW_TIMEOUT'
  | 'ADMIN_AGENT_STARTED'
  | 'ADMIN_AGENT_COMPLETED'
  | 'ADMIN_AGENT_FAILED'
  | 'ADMIN_AGENT_SKIPPED'
  | 'ADMIN_AUTHORIZATION_DENIED'
  | 'ADMIN_CAPABILITY_DENIED'
  | 'ADMIN_TOOL_DENIED'
  | 'ADMIN_RECOMMENDATION_GENERATED'
  | 'ADMIN_PRIVILEGED_ACTION_REQUESTED'
  | 'ADMIN_MEMORY_ACCESSED'
  | 'ADMIN_KNOWLEDGE_ACCESSED'
  | 'ADMIN_TOOL_USED'
  | 'ADMIN_INSUFFICIENT_DATA';

/** Severity of an admin-AI event. */
export type AdminAIEventSeverity = 'info' | 'warning' | 'error';

/** Safe metadata attached to an admin-AI event (never payloads). */
export interface AdminAIEventMetadata {
  readonly adminRequestId?: string;
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

/** An admin-AI event before identity/sequence resolution. */
export interface AdminAIEventInput {
  readonly type: AdminAIEventType;
  readonly occurredAt: string;
  readonly success?: boolean;
  readonly metadata?: AdminAIEventMetadata;
}

/** A fully resolved, immutable stored admin-AI event. */
export interface StoredAdminAIEvent {
  readonly eventId: string;
  readonly type: AdminAIEventType;
  readonly category: 'admin';
  readonly severity: AdminAIEventSeverity;
  readonly occurredAt: string;
  readonly sequence: number;
  readonly success?: boolean;
  readonly metadata?: AdminAIEventMetadata;
}

/** Options for the admin-AI event log. */
export interface AdminAIEventLogOptions {
  readonly eventIdFactory?: () => string;
}

/** The admin-AI event log (append-only, deterministic ordering). */
export class AdminAIEventLog {
  readonly name = 'admin-ai-event-log';

  private readonly events: StoredAdminAIEvent[] = [];
  private readonly eventIdFactory: () => string;

  constructor(options: AdminAIEventLogOptions = {}) {
    this.eventIdFactory = options.eventIdFactory ?? (() => `evt_admin_${this.events.length + 1}`);
  }

  /** Appends a resolved event and returns it. */
  append(input: AdminAIEventInput): StoredAdminAIEvent {
    const event: StoredAdminAIEvent = {
      eventId: this.eventIdFactory(),
      type: input.type,
      category: 'admin',
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
  query(): readonly StoredAdminAIEvent[] {
    return Object.freeze([...this.events]);
  }

  /** Number of stored events. */
  count(): number {
    return this.events.length;
  }

  /** Most recent stored event (undefined when empty). */
  latest(): StoredAdminAIEvent | undefined {
    return this.events.length > 0 ? this.events[this.events.length - 1] : undefined;
  }

  /** Events of a single type, in append order. */
  ofType(type: AdminAIEventType): readonly StoredAdminAIEvent[] {
    return Object.freeze(this.events.filter((event) => event.type === type));
  }
}

function severityFor(input: AdminAIEventInput): AdminAIEventSeverity {
  if (input.success === false) {
    return 'error';
  }
  if (
    input.type === 'ADMIN_WORKFLOW_CANCELLED' ||
    input.type === 'ADMIN_WORKFLOW_TIMEOUT' ||
    input.type === 'ADMIN_INSUFFICIENT_DATA' ||
    input.type === 'ADMIN_AUTHORIZATION_DENIED' ||
    input.type === 'ADMIN_CAPABILITY_DENIED' ||
    input.type === 'ADMIN_TOOL_DENIED'
  ) {
    return 'warning';
  }
  return 'info';
}
