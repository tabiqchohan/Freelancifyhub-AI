import type { ToolActorGroup, ToolResultStatus } from '../enums/index.js';
import { ToolEventType } from '../enums/index.js';
import type {
  IsoTimestamp,
  RequestId,
  ToolJsonValue,
  ToolNamespace,
  TraceId,
} from '../types/index.js';

/** Event source provenance. */
export type ToolEventSource = 'registry' | 'execution' | 'security' | 'system';
/** Event severity. */
export type ToolEventSeverity = 'info' | 'warning' | 'critical';
/** Event category. */
export type ToolEventCategory = 'registry' | 'execution' | 'security' | 'system';

/** A single, correlated tool event. Never carries tool input/output. */
export interface ToolEvent {
  readonly eventId?: string;
  readonly type: ToolEventType;
  readonly traceId: TraceId;
  readonly occurredAt: IsoTimestamp;
  readonly timestamp?: IsoTimestamp;
  readonly namespace: ToolNamespace;
  readonly toolId?: string;
  readonly toolName?: string;
  readonly toolVersion?: string;
  readonly versionId?: string;
  readonly executionId?: string;
  readonly actorGroup?: ToolActorGroup;
  readonly actorId?: string;
  readonly organizationId?: string;
  readonly workspaceId?: string;
  readonly projectId?: string;
  readonly requestId?: RequestId;
  readonly correlationId?: string;
  readonly source?: ToolEventSource;
  readonly service?: string;
  readonly severity?: ToolEventSeverity;
  readonly category?: ToolEventCategory;
  readonly status?: ToolResultStatus;
  readonly errorCode?: string;
  readonly reason?: string;
  /** Sanitized, primitive-only metadata. Never raw input/output. */
  readonly metadata?: Readonly<Record<string, ToolJsonValue>>;
}

/** Stored, immutable tool event. */
export interface StoredToolEvent {
  readonly eventId: string;
  readonly type: ToolEventType;
  readonly occurredAt: IsoTimestamp;
  readonly timestamp: IsoTimestamp;
  readonly sequence: number;
  readonly traceId: TraceId;
  readonly correlationId?: string;
  readonly requestId?: RequestId;
  readonly namespace: ToolNamespace;
  readonly toolId?: string;
  readonly toolName?: string;
  readonly toolVersion?: string;
  readonly versionId?: string;
  readonly executionId?: string;
  readonly actorId?: string;
  readonly actorGroup?: ToolActorGroup;
  readonly organizationId?: string;
  readonly workspaceId?: string;
  readonly projectId?: string;
  readonly source: ToolEventSource;
  readonly service?: string;
  readonly severity: ToolEventSeverity;
  readonly category: ToolEventCategory;
  readonly status?: ToolResultStatus;
  readonly errorCode?: string;
  readonly reason?: string;
  readonly metadata?: Readonly<Record<string, ToolJsonValue>>;
}

/** Default category derived from the event type. */
export function toolCategoryForType(type: ToolEventType): ToolEventCategory {
  switch (type) {
    case ToolEventType.Registered:
    case ToolEventType.Updated:
    case ToolEventType.Enabled:
    case ToolEventType.Disabled:
    case ToolEventType.Removed:
      return 'registry';
    case ToolEventType.ExecutionStarted:
    case ToolEventType.ExecutionSucceeded:
    case ToolEventType.ExecutionFailed:
    case ToolEventType.ExecutionTimeout:
    case ToolEventType.ExecutionCancelled:
      return 'execution';
    case ToolEventType.AuthorizationDenied:
      return 'security';
    default:
      return 'system';
  }
}

/** Default severity derived from the event type. */
export function toolSeverityForType(type: ToolEventType): ToolEventSeverity {
  switch (type) {
    case ToolEventType.AuthorizationDenied:
    case ToolEventType.ExecutionFailed:
      return 'warning';
    default:
      return 'info';
  }
}

/** Default source derived from the event type. */
export function toolSourceForType(type: ToolEventType): ToolEventSource {
  switch (type) {
    case ToolEventType.AuthorizationDenied:
      return 'security';
    case ToolEventType.ExecutionStarted:
    case ToolEventType.ExecutionSucceeded:
    case ToolEventType.ExecutionFailed:
    case ToolEventType.ExecutionTimeout:
    case ToolEventType.ExecutionCancelled:
      return 'execution';
    case ToolEventType.Registered:
    case ToolEventType.Updated:
    case ToolEventType.Enabled:
    case ToolEventType.Disabled:
    case ToolEventType.Removed:
      return 'registry';
    default:
      return 'system';
  }
}

export * from './log.js';
