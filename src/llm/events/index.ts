import { randomUUID } from 'node:crypto';

import type { LLMErrorClass } from '../errors/index.js';

/**
 * Sprint 17 — LLM / reasoning event + audit log.
 *
 * Follows the subsystem-scoped event-log convention established by AG-003 and
 * AG-004 (AG-002 InMemoryEventLog / AG-003 KnowledgeEventLog / AG-004
 * ToolEventLog). In-memory, append-only, challenge-safe. Events NEVER include
 * the API key, authorization headers, credentials, raw prompts, or raw model
 * responses — only identifiers, counts, durations, retry counts, token usage,
 * and error categories.
 */

/** Categories of reasoning lifecycle events. */
export type LLMEventCategory =
  | 'configuration'
  | 'execution'
  | 'retry'
  | 'authentication'
  | 'rate_limit'
  | 'timeout'
  | 'network'
  | 'provider'
  | 'validation';

/** Typed reasoning event kinds. */
export type LLMEventType =
  | 'llm.reasoning.started'
  | 'llm.reasoning.succeeded'
  | 'llm.reasoning.failed'
  | 'llm.reasoning.cancelled'
  | 'llm.reasoning.timeout'
  | 'llm.reasoning.retry'
  | 'llm.reasoning.auth_failed'
  | 'llm.reasoning.rate_limited'
  | 'llm.reasoning.network_error'
  | 'llm.reasoning.provider_error'
  | 'llm.reasoning.validation_error'
  | 'llm.reasoning.unsupported';

/** Severity of an event. */
export type LLMEventSeverity = 'info' | 'warning' | 'error';

/** Safe metadata about a reasoning event. No prompt/response/secret content. */
export interface LLMEventMetadata {
  readonly correlationId?: string;
  readonly requestId?: string;
  readonly agentId?: string;
  readonly provider: string;
  readonly model: string;
  readonly durationMs?: number;
  readonly retryCount?: number;
  readonly attempts?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly finishReason?: string;
}

/** An event before id/category/severity are resolved. */
export interface LLMEvent {
  readonly eventId?: string;
  readonly type: LLMEventType;
  readonly occurredAt: string;
  readonly traceId?: string;
  readonly success?: boolean;
  readonly errorClass?: LLMErrorClass;
  readonly errorCode?: string;
  readonly metadata?: LLMEventMetadata;
}

/** A single stored reasoning event (fully resolved, immutable). */
export interface StoredLLMEvent {
  readonly eventId: string;
  readonly type: LLMEventType;
  readonly category: LLMEventCategory;
  readonly severity: LLMEventSeverity;
  readonly occurredAt: string;
  readonly sequence: number;
  readonly traceId?: string;
  readonly success?: boolean;
  readonly errorClass?: LLMErrorClass;
  readonly errorCode?: string;
  readonly metadata?: LLMEventMetadata;
}

/** Maps an {@link LLMErrorClass} to its event category + type. */
export function llmCategoryForError(errorClass: LLMErrorClass): LLMEventCategory {
  switch (errorClass) {
    case 'authentication':
      return 'authentication';
    case 'rate_limit':
      return 'rate_limit';
    case 'timeout':
      return 'timeout';
    case 'network':
      return 'network';
    case 'response_validation':
    case 'invalid_request':
      return 'validation';
    case 'cancelled':
      return 'execution';
    case 'configuration':
      return 'configuration';
    case 'provider':
      return 'provider';
    default:
      return 'execution';
  }
}

/** Maps an {@link LLMErrorClass} to its typed event kind. */
export function llmTypeForError(errorClass: LLMErrorClass): LLMEventType {
  switch (errorClass) {
    case 'authentication':
      return 'llm.reasoning.auth_failed';
    case 'rate_limit':
      return 'llm.reasoning.rate_limited';
    case 'timeout':
      return 'llm.reasoning.timeout';
    case 'network':
      return 'llm.reasoning.network_error';
    case 'response_validation':
    case 'invalid_request':
      return 'llm.reasoning.validation_error';
    case 'cancelled':
      return 'llm.reasoning.cancelled';
    case 'configuration':
      return 'llm.reasoning.unsupported';
    case 'provider':
      return 'llm.reasoning.provider_error';
    default:
      return 'llm.reasoning.failed';
  }
}

/** Severity assigned to an error category. */
export function llmSeverityForError(errorClass?: LLMErrorClass): LLMEventSeverity {
  switch (errorClass) {
    case 'cancelled':
      return 'info';
    case 'timeout':
    case 'network':
    case 'rate_limit':
      return 'warning';
    case 'authentication':
    case 'provider':
    case 'response_validation':
      return 'error';
    default:
      return 'warning';
  }
}

/** Maps a type to its category. */
export function llmCategoryForType(type: LLMEventType): LLMEventCategory {
  if (type.startsWith('llm.reasoning.auth')) {
    return 'authentication';
  }
  if (type.startsWith('llm.reasoning.rate')) {
    return 'rate_limit';
  }
  if (type.startsWith('llm.reasoning.timeout')) {
    return 'timeout';
  }
  if (type.startsWith('llm.reasoning.network')) {
    return 'network';
  }
  if (type.startsWith('llm.reasoning.validation')) {
    return 'validation';
  }
  if (type.startsWith('llm.reasoning.provider')) {
    return 'provider';
  }
  if (type === 'llm.reasoning.unsupported') {
    return 'configuration';
  }
  return 'execution';
}

function defaultEventIdFactory(): string {
  return `lev_${randomUUID()}`;
}

function deepFreeze(value: unknown): void {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      if (child !== null && typeof child === 'object') {
        deepFreeze(child);
      }
    }
  }
}

/** Options for the reasoning event log. */
export interface LLMEventLogOptions {
  readonly maxPageSize?: number;
  readonly eventIdFactory?: () => string;
}

/** Query filter for the reasoning event log. */
export interface LLMEventFilter {
  readonly type?: LLMEventType;
  readonly traceId?: string;
  readonly correlationId?: string;
  readonly requestId?: string;
  readonly success?: boolean;
  readonly errorClass?: LLMErrorClass;
}

/** Query input for the reasoning event log. */
export interface LLMEventQuery extends LLMEventFilter {
  readonly limit?: number;
  readonly cursor?: string;
  readonly maxPageSize?: number;
}

/** Page of reasoning events. */
export interface LLMEventPage {
  readonly items: readonly StoredLLMEvent[];
  readonly hasMore: boolean;
  readonly total: number;
  readonly pageSize: number;
}

function matchesFilter(event: StoredLLMEvent, filter: LLMEventFilter): boolean {
  if (filter.type !== undefined && event.type !== filter.type) {
    return false;
  }
  if (filter.traceId !== undefined && event.traceId !== filter.traceId) {
    return false;
  }
  if (
    filter.correlationId !== undefined &&
    event.metadata?.correlationId !== filter.correlationId
  ) {
    return false;
  }
  if (filter.requestId !== undefined && event.metadata?.requestId !== filter.requestId) {
    return false;
  }
  if (filter.success !== undefined && event.success !== filter.success) {
    return false;
  }
  if (filter.errorClass !== undefined && event.errorClass !== filter.errorClass) {
    return false;
  }
  return true;
}

/**
 * Append-only in-memory reasoning event log. Rejects events missing the
 * required invariant fields and duplicate event ids, keeping the trail
 * deterministic and free of corruption.
 */
export class LLMEventLog {
  readonly name = 'llm-event-log';
  readonly backend = 'in-memory';

  private readonly maxPageSize: number;
  private readonly eventIdFactory: () => string;

  private readonly stored: StoredLLMEvent[] = [];
  private readonly byId = new Map<string, StoredLLMEvent>();
  private nextSequence = 0;

  get pageSize(): number {
    return this.maxPageSize;
  }

  constructor(options: LLMEventLogOptions = {}) {
    this.maxPageSize = options.maxPageSize ?? 50;
    this.eventIdFactory = options.eventIdFactory ?? defaultEventIdFactory;
  }

  /** Appends an event; throws on duplicate id or missing required fields. */
  append(event: LLMEvent): StoredLLMEvent {
    if (!event.type || !event.occurredAt) {
      throw new Error('LLM event missing required fields');
    }

    const eventId = event.eventId ?? this.eventIdFactory();
    if (this.byId.has(eventId)) {
      throw new Error(`Duplicate LLM event id: ${eventId}`, { cause: eventId });
    }

    const category =
      event.errorClass !== undefined
        ? llmCategoryForError(event.errorClass)
        : llmCategoryForType(event.type);
    const severity =
      event.errorClass !== undefined
        ? llmSeverityForError(event.errorClass)
        : llmSeverityForError(undefined);

    const stored: StoredLLMEvent = {
      eventId,
      type: event.type,
      category,
      severity,
      occurredAt: event.occurredAt,
      sequence: this.nextSequence,
      traceId: event.traceId,
      success: event.success,
      errorClass: event.errorClass,
      errorCode: event.errorCode,
      metadata: event.metadata,
    };

    deepFreeze(stored);
    this.stored.push(stored);
    this.byId.set(eventId, stored);
    this.nextSequence += 1;
    return stored;
  }

  getById(eventId: string): StoredLLMEvent | undefined {
    return this.byId.get(eventId);
  }

  query(query: LLMEventQuery): LLMEventPage {
    const limit = Math.max(1, Math.min(query.limit ?? this.maxPageSize, this.maxPageSize));
    const filter: LLMEventFilter = { ...query };

    const matched = this.stored.filter((event) => matchesFilter(event, filter));
    const total = matched.length;

    let start = 0;
    if (query.cursor !== undefined) {
      const idx = matched.findIndex((e) => e.eventId === query.cursor);
      if (idx >= 0) {
        start = idx + 1;
      }
    }

    const items = matched.slice(start, start + limit);
    const hasMore = start + limit < total;

    return { items, hasMore, total, pageSize: items.length };
  }

  count(filter?: LLMEventFilter): number {
    if (filter === undefined) {
      return this.stored.length;
    }
    return this.stored.filter((event) => matchesFilter(event, filter)).length;
  }

  latest(limit?: number): readonly StoredLLMEvent[] {
    const resolved = Math.max(1, Math.min(limit ?? this.maxPageSize, this.maxPageSize));
    return this.stored.slice(Math.max(0, this.stored.length - resolved)).reverse();
  }

  clear(): void {
    this.stored.length = 0;
    this.byId.clear();
    this.nextSequence = 0;
  }
}

/** Creates an LLMEventLog with validated options. */
export function createLLMEventLog(options: LLMEventLogOptions = {}): LLMEventLog {
  return new LLMEventLog(options);
}

/** Records a started reasoning event with zero secret-bearing content. */
export function startedEvent(input: {
  readonly traceId?: string;
  readonly correlationId?: string;
  readonly provider: string;
  readonly model: string;
  readonly occurredAt: string;
}): LLMEvent {
  return {
    type: 'llm.reasoning.started',
    occurredAt: input.occurredAt,
    traceId: input.traceId,
    metadata: { correlationId: input.correlationId, provider: input.provider, model: input.model },
  };
}

/** Records a successful reasoning event. */
export function succeededEvent(input: {
  readonly traceId?: string;
  readonly correlationId?: string;
  readonly provider: string;
  readonly model: string;
  readonly occurredAt: string;
  readonly durationMs: number;
  readonly attempts?: number;
  readonly usage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly totalTokens?: number;
  };
  readonly finishReason?: string;
}): LLMEvent {
  return {
    type: 'llm.reasoning.succeeded',
    occurredAt: input.occurredAt,
    traceId: input.traceId,
    success: true,
    metadata: {
      correlationId: input.correlationId,
      provider: input.provider,
      model: input.model,
      durationMs: input.durationMs,
      attempts: input.attempts,
      inputTokens: input.usage?.inputTokens,
      outputTokens: input.usage?.outputTokens,
      totalTokens: input.usage?.totalTokens,
      finishReason: input.finishReason,
    },
  };
}

/** Records a failed reasoning event (safe error category/code only). */
export function failedEvent(input: {
  readonly traceId?: string;
  readonly correlationId?: string;
  readonly provider: string;
  readonly model: string;
  readonly occurredAt: string;
  readonly durationMs?: number;
  readonly retryCount?: number;
  readonly attempts?: number;
  readonly errorClass?: LLMErrorClass;
  readonly errorCode?: string;
}): LLMEvent {
  return {
    type:
      input.errorClass !== undefined ? llmTypeForError(input.errorClass) : 'llm.reasoning.failed',
    occurredAt: input.occurredAt,
    traceId: input.traceId,
    success: false,
    errorClass: input.errorClass,
    errorCode: input.errorCode,
    metadata: {
      correlationId: input.correlationId,
      provider: input.provider,
      model: input.model,
      durationMs: input.durationMs,
      retryCount: input.retryCount,
      attempts: input.attempts,
    },
  };
}

/** Records an in-flight retry (safe metadata only). */
export function retryEvent(input: {
  readonly traceId?: string;
  readonly correlationId?: string;
  readonly provider: string;
  readonly model: string;
  readonly occurredAt: string;
  readonly attempt: number;
  readonly delayMs: number;
  readonly errorClass?: LLMErrorClass;
  readonly errorCode?: string;
}): LLMEvent {
  return {
    type: 'llm.reasoning.retry',
    occurredAt: input.occurredAt,
    traceId: input.traceId,
    errorClass: input.errorClass,
    errorCode: input.errorCode,
    metadata: {
      correlationId: input.correlationId,
      provider: input.provider,
      model: input.model,
      retryCount: input.attempt,
    },
  };
}
