import type { KnowledgeActorGroup } from '../enums/index.js';
import type {
  IsoTimestamp,
  KnowledgeId,
  KnowledgeJsonValue,
  KnowledgeNamespace,
  KnowledgeVersionId,
  RequestId,
  TraceId,
} from '../types/index.js';

/**
 * Knowledge event types emitted by the audit system.
 */
export enum KnowledgeAuditEventType {
  Created = 'KNOWLEDGE_CREATED',
  VersionCreated = 'KNOWLEDGE_VERSION_CREATED',
  Updated = 'KNOWLEDGE_UPDATED',
  Archived = 'KNOWLEDGE_ARCHIVED',
  Restored = 'KNOWLEDGE_RESTORED',
  Expired = 'KNOWLEDGE_EXPIRED',
  Deleted = 'KNOWLEDGE_DELETED',
  Retrieved = 'KNOWLEDGE_RETRIEVED',
  AccessDenied = 'KNOWLEDGE_ACCESS_DENIED',
}

/** Event source provenance. */
export type KnowledgeEventSource = 'knowledge' | 'lifecycle' | 'security' | 'retrieval' | 'system';

/** Categorical severity. */
export type KnowledgeEventSeverity = 'info' | 'warning' | 'critical';

/** Coarse event category. */
export type KnowledgeEventCategory =
  'knowledge' | 'lifecycle' | 'security' | 'retrieval' | 'system';

/** A single, correlated knowledge event. */
export interface KnowledgeEvent {
  readonly eventId?: string;
  readonly type: KnowledgeAuditEventType;
  readonly traceId: TraceId;
  readonly occurredAt: IsoTimestamp;
  readonly timestamp?: IsoTimestamp;
  readonly namespace: KnowledgeNamespace;
  readonly knowledgeId?: KnowledgeId;
  readonly versionId?: KnowledgeVersionId;
  readonly actorGroup?: KnowledgeActorGroup;
  readonly actorId?: string;
  readonly versionNumber?: number;
  readonly previousVersionNumber?: number;
  readonly reason?: string;
  readonly count?: number;
  readonly permission?: string;
  readonly denialReason?: string;
  readonly denialCode?: string;
  readonly requestId?: RequestId;
  readonly correlationId?: string;
  readonly organizationId?: string;
  readonly workspaceId?: string;
  readonly projectId?: string;
  readonly source?: KnowledgeEventSource;
  readonly service?: string;
  readonly severity?: KnowledgeEventSeverity;
  readonly category?: KnowledgeEventCategory;
  readonly metadata?: Readonly<Record<string, KnowledgeJsonValue>>;
}

/** Stored, immutable knowledge event. */
export interface StoredKnowledgeEvent {
  readonly eventId: string;
  readonly type: KnowledgeAuditEventType;
  readonly occurredAt: IsoTimestamp;
  readonly timestamp: IsoTimestamp;
  readonly sequence: number;
  readonly traceId: TraceId;
  readonly correlationId?: string;
  readonly requestId?: RequestId;
  readonly namespace: KnowledgeNamespace;
  readonly knowledgeId?: KnowledgeId;
  readonly versionId?: KnowledgeVersionId;
  readonly actorId?: string;
  readonly actorGroup?: KnowledgeActorGroup;
  readonly organizationId?: string;
  readonly workspaceId?: string;
  readonly projectId?: string;
  readonly versionNumber?: number;
  readonly previousVersionNumber?: number;
  readonly reason?: string;
  readonly count?: number;
  readonly permission?: string;
  readonly denialReason?: string;
  readonly denialCode?: string;
  readonly source?: KnowledgeEventSource;
  readonly service?: string;
  readonly severity: KnowledgeEventSeverity;
  readonly category: KnowledgeEventCategory;
  readonly metadata?: Readonly<Record<string, KnowledgeJsonValue>>;
}

/** Default category derived from the event type. */
export function knowledgeCategoryForType(type: KnowledgeAuditEventType): KnowledgeEventCategory {
  switch (type) {
    case KnowledgeAuditEventType.Created:
    case KnowledgeAuditEventType.VersionCreated:
    case KnowledgeAuditEventType.Updated:
    case KnowledgeAuditEventType.Archived:
    case KnowledgeAuditEventType.Restored:
    case KnowledgeAuditEventType.Expired:
    case KnowledgeAuditEventType.Deleted:
      return 'lifecycle';
    case KnowledgeAuditEventType.Retrieved:
      return 'retrieval';
    case KnowledgeAuditEventType.AccessDenied:
      return 'security';
    default:
      return 'knowledge';
  }
}

/** Default severity derived from the event type. */
export function knowledgeSeverityForType(type: KnowledgeAuditEventType): KnowledgeEventSeverity {
  switch (type) {
    case KnowledgeAuditEventType.AccessDenied:
      return 'warning';
    default:
      return 'info';
  }
}

/** Default source derived from the event type. */
export function knowledgeSourceForType(type: KnowledgeAuditEventType): KnowledgeEventSource {
  switch (type) {
    case KnowledgeAuditEventType.AccessDenied:
      return 'security';
    case KnowledgeAuditEventType.Retrieved:
      return 'retrieval';
    case KnowledgeAuditEventType.Created:
    case KnowledgeAuditEventType.VersionCreated:
    case KnowledgeAuditEventType.Updated:
    case KnowledgeAuditEventType.Archived:
    case KnowledgeAuditEventType.Restored:
    case KnowledgeAuditEventType.Expired:
    case KnowledgeAuditEventType.Deleted:
      return 'lifecycle';
    default:
      return 'system';
  }
}

export * from './log.js';
