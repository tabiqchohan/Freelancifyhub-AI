import type {
  MemoryLifecycleState,
  MemoryOwnerKind,
  MemoryPriority,
  MemorySecurityLevel,
  MemoryType,
} from '../enums/index.js';

/** Shared, transport-agnostic scalar types for the AG-002 Memory Manager. */

/** ISO-8601 timestamp string (records are JSON-serializable, no Date objects). */
export type IsoTimestamp = string;

/** Correlation identifier propagated across every memory hop (spec §21). */
export type TraceId = string;

/** Identifier for a single request/invocation. */
export type RequestId = string;

/** Unique identifier of a memory record. */
export type MemoryId = string;

/** Logical address of a memory record inside a namespace. */
export type MemoryKey = string;

/** Isolation scope every key belongs to (spec §2, ADR-MEM-001). */
export type MemoryNamespace = string;

/** Identifier of an owning entity (user/project/workspace/org/agent/system). */
export type MemoryOwnerId = string;

/** JSON-compatible primitive. */
export type MemoryJsonPrimitive = string | number | boolean | null;

/**
 * Recursive JSON-compatible value used for memory content and metadata. Keeps
 * records serializable and avoids `any` (prompt §4). Objects are readonly from
 * the consumer perspective; parsed values remain mutable internally.
 */
export type MemoryJsonValue =
  MemoryJsonPrimitive | readonly MemoryJsonValue[] | { readonly [key: string]: MemoryJsonValue };

/** Structured memory content — never forced into a string (prompt §4). */
export type MemoryContent = MemoryJsonValue;

/** Key-value metadata attached to a memory record. */
export type MemoryMetadata = Readonly<Record<string, MemoryJsonValue>>;

/** Who owns a memory record (spec §6, prompt §6). */
export interface MemoryOwner {
  readonly kind: MemoryOwnerKind;
  readonly id: MemoryOwnerId;
}

/** Origin of a memory record (spec §4.7, summarization pointers §10). */
export type MemorySourceKind = 'knowledge_reference' | 'summarization' | 'external';

/** Source/reference information where required by the architecture. */
export interface MemorySource {
  readonly kind: MemorySourceKind;
  /** KB document id, summarized-record key set, or external reference. */
  readonly reference: string;
}

/** Retention policy kinds derived from per-type retention (spec §4). */
export type MemoryRetentionKind =
  | 'none'
  | 'rolling_window'
  | 'until_deletion'
  | 'milestone_summaries'
  | 'archive_on_close'
  | 'versioned'
  | 'annual_consolidation'
  | 'legal_hold'
  | 'invalidation';

/** Retention information attached to every record (spec §4, §9). */
export interface MemoryRetentionPolicy {
  readonly kind: MemoryRetentionKind;
  readonly description?: string;
}

/**
 * A strongly typed, serializable, versionable memory record (spec §4, §15,
 * prompt §3). Every write carries `owner + reason` (AC-MEM-3) and a trace id.
 */
export interface MemoryRecord {
  readonly id: MemoryId;
  /** Isolation namespace the record belongs to (never empty). */
  readonly namespace: MemoryNamespace;
  /** Logical address within the namespace. */
  readonly key: MemoryKey;
  readonly type: MemoryType;
  readonly owner: MemoryOwner;
  readonly content: MemoryContent;
  readonly metadata: MemoryMetadata;
  readonly priority: MemoryPriority;
  readonly securityLevel: MemorySecurityLevel;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  /** Effective expiration when a TTL applies (spec §9). */
  readonly expiresAt?: IsoTimestamp;
  /** TTL in milliseconds; 0 or absent means no expiry. */
  readonly ttlMs?: number;
  readonly retention: MemoryRetentionPolicy;
  /** Monotonic version, starting at 1 (prompt §21). */
  readonly version: number;
  readonly lifecycle: MemoryLifecycleState;
  /** Why this record was written (audit, AC-MEM-3). */
  readonly reason: string;
  readonly traceId: TraceId;
  readonly source?: MemorySource;
}

/** Attribute filters shared by repository listing and retrieval queries. */
export interface MemoryRecordFilter {
  readonly namespace?: MemoryNamespace;
  readonly key?: MemoryKey;
  readonly type?: MemoryType;
  readonly owner?: MemoryOwner;
  readonly priority?: MemoryPriority;
  readonly securityLevel?: MemorySecurityLevel;
  readonly lifecycle?: MemoryLifecycleState;
}

/** Bounds enforced on records entering the memory system (spec §17, §27). */
export interface MemorySizeLimits {
  /** Maximum serialized content bytes (UTF-8). */
  readonly maxContentBytes: number;
  /** Maximum metadata keys per record. */
  readonly maxMetadataKeys: number;
}
