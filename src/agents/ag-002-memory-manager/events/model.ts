import type { MemoryActorGroup, MemoryLifecycleState } from '../enums/index.js';
import type {
  IsoTimestamp,
  MemoryId,
  MemoryJsonValue,
  MemoryKey,
  MemoryNamespace,
  RequestId,
  TraceId,
} from '../types/index.js';
import { MemoryEventType } from './index.js';
import type {
  MemoryEventCategory,
  MemoryEventId,
  MemoryEventSeverity,
  MemoryEventSource,
} from './index.js';

/**
 * Sprint 7 — Canonical audit record (spec §2, §3).
 *
 * Every event stored by the EventLog is normalised into a {@link StoredMemoryEvent}
 * with stable, required metadata: a unique {@link MemoryEventId}, a monotonic
 * {@link sequence}, a canonical timestamp and derived severity/category. The
 * transport {@link MemoryEvent} remains the loose, optional-field shape that
 * services emit; this is the immutable, queryable projection stored for audit.
 */
export interface StoredMemoryEvent {
  readonly eventId: MemoryEventId;
  /** Canonical alias of {@link MemoryEventType}. */
  readonly type: MemoryEventType;
  readonly eventType: MemoryEventType;
  readonly occurredAt: IsoTimestamp;
  readonly timestamp: IsoTimestamp;
  /** Globally monotonic order, assigned on append (spec §9). */
  readonly sequence: number;
  readonly traceId: TraceId;
  readonly correlationId?: string;
  readonly requestId?: RequestId;
  readonly namespace: MemoryNamespace;
  readonly key: MemoryKey;
  readonly memoryId?: MemoryId;
  readonly actorId?: string;
  readonly actorType?: string;
  readonly actorGroup?: MemoryActorGroup;
  readonly organizationId?: string;
  readonly workspaceId?: string;
  readonly projectId?: string;
  readonly previousState?: MemoryLifecycleState;
  readonly newState?: MemoryLifecycleState;
  readonly version?: number;
  readonly previousVersion?: number;
  readonly source?: MemoryEventSource;
  readonly service?: string;
  readonly severity: MemoryEventSeverity;
  readonly category: MemoryEventCategory;
  readonly reason?: string;
  readonly hard?: boolean;
  readonly archiveId?: string;
  readonly count?: number;
  readonly permission?: string;
  readonly targetType?: string;
  readonly targetSecurityLevel?: string;
  readonly denialReason?: string;
  readonly denialCode?: string;
  readonly consolidationId?: string;
  readonly sourceIds?: readonly MemoryId[];
  readonly outputId?: MemoryId;
  readonly candidateGroupSize?: number;
  /** Sanitized, content-free metadata (never raw content). */
  readonly metadata?: Readonly<Record<string, MemoryJsonValue>>;
}

/** Default source/category when an event does not declare one. */
export function categoryForType(type: MemoryEventType): MemoryEventCategory {
  switch (type) {
    case MemoryEventType.Created:
    case MemoryEventType.Activated:
    case MemoryEventType.Updated:
    case MemoryEventType.Expired:
    case MemoryEventType.Archived:
    case MemoryEventType.Deleted:
      return 'lifecycle';
    case MemoryEventType.Retrieved:
      return 'retrieval';
    case MemoryEventType.Summarized:
    case MemoryEventType.MemoryConsolidated:
      return 'consolidation';
    case MemoryEventType.AccessAllowed:
    case MemoryEventType.AccessDenied:
    case MemoryEventType.ReadDenied:
    case MemoryEventType.WriteDenied:
    case MemoryEventType.UpdateDenied:
    case MemoryEventType.DeleteDenied:
    case MemoryEventType.ArchiveDenied:
      return 'security';
    default:
      return 'memory';
  }
}

/** Default severity derived from the event type when none is declared. */
export function severityForType(type: MemoryEventType): MemoryEventSeverity {
  switch (type) {
    case MemoryEventType.AccessDenied:
    case MemoryEventType.ReadDenied:
    case MemoryEventType.WriteDenied:
    case MemoryEventType.UpdateDenied:
    case MemoryEventType.DeleteDenied:
    case MemoryEventType.ArchiveDenied:
      return 'warning';
    default:
      return 'info';
  }
}

/** Default provenance source derived from the event type when none is declared. */
export function sourceForType(type: MemoryEventType): MemoryEventSource {
  switch (type) {
    case MemoryEventType.AccessAllowed:
    case MemoryEventType.AccessDenied:
    case MemoryEventType.ReadDenied:
    case MemoryEventType.WriteDenied:
    case MemoryEventType.UpdateDenied:
    case MemoryEventType.DeleteDenied:
    case MemoryEventType.ArchiveDenied:
      return 'security';
    case MemoryEventType.MemoryConsolidated:
    case MemoryEventType.Summarized:
      return 'consolidation';
    case MemoryEventType.Retrieved:
      return 'retrieval';
    case MemoryEventType.Created:
    case MemoryEventType.Activated:
    case MemoryEventType.Updated:
    case MemoryEventType.Expired:
    case MemoryEventType.Archived:
    case MemoryEventType.Deleted:
      return 'lifecycle';
    default:
      return 'system';
  }
}
