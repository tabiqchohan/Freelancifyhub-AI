import type {
  KnowledgeContentType,
  KnowledgeLifecycleState,
  KnowledgeSecurityLevel,
  KnowledgeSourceType,
} from '../enums/index.js';

/** ISO-8601 timestamp string. */
export type IsoTimestamp = string;

/** Correlation identifier. */
export type TraceId = string;

/** Request identifier. */
export type RequestId = string;

/** Unique identifier of a knowledge document. */
export type KnowledgeId = string;

/** Unique identifier of a knowledge version. */
export type KnowledgeVersionId = string;

/** Unique identifier of a knowledge chunk. */
export type KnowledgeChunkId = string;

/** Namespace/scope for knowledge isolation. */
export type KnowledgeNamespace = string;

/** JSON-compatible primitive. */
export type KnowledgeJsonPrimitive = string | number | boolean | null;

/** Recursive JSON-compatible value for metadata. */
export type KnowledgeJsonValue =
  | KnowledgeJsonPrimitive
  | readonly KnowledgeJsonValue[]
  | { readonly [key: string]: KnowledgeJsonValue };

/** Key-value metadata attached to a knowledge document. */
export type KnowledgeMetadata = Readonly<Record<string, KnowledgeJsonValue>>;

/** Source metadata describing where knowledge came from. */
export interface KnowledgeSourceMetadata {
  readonly sourceType: KnowledgeSourceType;
  readonly reference?: string;
  readonly author?: string;
  readonly url?: string;
  readonly version?: string;
}

/** Size limits for knowledge documents. */
export interface KnowledgeSizeLimits {
  readonly maxContentBytes: number;
  readonly maxMetadataKeys: number;
  readonly maxTitleLength: number;
}

/** A knowledge document — the core domain entity. */
export interface KnowledgeDocument {
  readonly id: KnowledgeId;
  readonly namespace: KnowledgeNamespace;
  readonly title: string;
  readonly content: string;
  readonly contentType: KnowledgeContentType;
  readonly source: KnowledgeSourceMetadata;
  readonly metadata: KnowledgeMetadata;
  readonly lifecycle: KnowledgeLifecycleState;
  readonly securityLevel: KnowledgeSecurityLevel;
  /** Current active version number (starts at 1). */
  readonly version: number;
  /** Content checksum (deterministic, SHA-256 hex). */
  readonly contentHash: string;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly createdBy: string;
  readonly updatedBy: string;
  readonly traceId: TraceId;
}

/** An immutable version snapshot of a knowledge document. */
export interface KnowledgeVersion {
  readonly id: KnowledgeVersionId;
  readonly documentId: KnowledgeId;
  readonly versionNumber: number;
  readonly title: string;
  readonly content: string;
  readonly contentType: KnowledgeContentType;
  readonly source: KnowledgeSourceMetadata;
  readonly metadata: KnowledgeMetadata;
  readonly securityLevel: KnowledgeSecurityLevel;
  readonly contentHash: string;
  readonly createdAt: IsoTimestamp;
  readonly createdBy: string;
  readonly traceId: TraceId;
}

/** A chunk of text from a knowledge document version. */
export interface KnowledgeChunk {
  readonly id: KnowledgeChunkId;
  readonly documentId: KnowledgeId;
  readonly versionId: KnowledgeVersionId;
  readonly versionNumber: number;
  readonly chunkIndex: number;
  readonly content: string;
  readonly contentHash: string;
  readonly metadata: KnowledgeMetadata;
  readonly createdAt: IsoTimestamp;
}

/** Filter criteria for listing knowledge documents. */
export interface KnowledgeDocumentFilter {
  readonly namespace?: KnowledgeNamespace;
  readonly lifecycle?: KnowledgeLifecycleState;
  readonly securityLevel?: KnowledgeSecurityLevel;
  readonly contentType?: KnowledgeContentType;
  readonly sourceType?: KnowledgeSourceType;
  readonly createdBy?: string;
}

/** Pagination input for deterministic listing. */
export interface KnowledgePagination {
  readonly offset: number;
  readonly limit: number;
  /** Sort key for deterministic ordering. Default: 'created_at'. */
  readonly sortBy?: 'created_at' | 'updated_at' | 'title';
  readonly sortDirection?: 'asc' | 'desc';
}

/** A page of knowledge documents. */
export interface KnowledgeDocumentPage {
  readonly items: readonly KnowledgeDocument[];
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
  readonly hasMore: boolean;
}

/** Retrievable knowledge for the AG-001 integration layer. */
export interface KnowledgeRetrievalResult {
  readonly documentId: KnowledgeId;
  readonly versionId: KnowledgeVersionId;
  readonly chunkId?: KnowledgeChunkId;
  readonly title: string;
  readonly content: string;
  readonly namespace: KnowledgeNamespace;
  readonly securityLevel: KnowledgeSecurityLevel;
  readonly source: KnowledgeSourceMetadata;
  readonly score: number;
  readonly scoreExplanations: readonly ScoreExplanation[];
  readonly version: number;
}

/** Explanation of how a retrieval score was computed. */
export interface ScoreExplanation {
  readonly signal: string;
  readonly contribution: number;
  readonly detail: string;
}
