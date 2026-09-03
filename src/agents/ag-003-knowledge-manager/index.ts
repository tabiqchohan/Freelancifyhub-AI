/**
 * AG-003 Knowledge Manager — public barrel (Sprint 15).
 */

export * from './enums/index.js';
export * from './types/index.js';
export * from './errors/index.js';

export {
  normalizeKnowledgeInput,
  normalizeTitle,
  normalizeContent,
  normalizeWhitespace,
  normalizeNewlines,
  normalizeMetadata,
  normalizeSource,
  normalizeNamespace,
  validateContentNotEmpty,
  type NormalizeKnowledgeInput,
  type NormalizedKnowledgeInput,
} from './normalization/index.js';

export {
  chunkDocument,
  splitIntoChunks,
  deterministicChunkId,
  DEFAULT_CHUNKING_CONFIG,
  type ChunkingConfig,
  type ChunkDocumentInput,
} from './chunking/index.js';

export {
  createInitialVersion,
  createNewVersion,
  type VersionCreationResult,
  type VersionRetrievalResult,
} from './versioning/index.js';

export {
  DefaultKnowledgeLifecycle,
  knowledgeLifecycle,
  transitionKnowledgeDocument,
  type KnowledgeLifecycleContract,
  type KnowledgeLifecycleTransitionResult,
} from './lifecycle/index.js';

export {
  DefaultKnowledgeAuthorizationService,
  createKnowledgeAuthorizationService,
  KnowledgeMatrixPermissionPolicy,
  KnowledgeNamespaceScopePolicy,
  KnowledgeSecurityLevelPolicy,
  KnowledgeLifecycleAccessPolicy,
  KnowledgeOwnerPolicy,
  CompositeKnowledgeAuthorizationPolicy,
  validateKnowledgeActorContext,
  KNOWLEDGE_ACCESS_MATRIX,
  type KnowledgeActor,
  type KnowledgeAuthorizationService,
  type KnowledgeAuthorizationDecision,
  type KnowledgeAccessCheckInput,
  type KnowledgeAccessCheckTarget,
  type KnowledgeAuthorizationPolicy,
  type KnowledgeAuthorizationPolicyResult,
} from './security/index.js';

export { InMemoryKnowledgeRepository } from './repositories/in-memory.js';

export { PostgresKnowledgeRepository } from './storage/postgres.js';

export {
  migrateKnowledgeSchema,
  knowledgePendingMigrations,
  KNOWLEDGE_SCHEMA_VERSION,
  KNOWLEDGE_SCHEMA_MIGRATIONS,
  type KnowledgeSchemaMigration,
} from './storage/schema.js';

export {
  retrieveKnowledge,
  scoreDocument,
  type KnowledgeRetrievalInput,
} from './retrieval/index.js';

export {
  KnowledgeManagerService,
  createKnowledgeManagerService,
  type KnowledgeRepository,
  type KnowledgeServiceDependencies,
  type CreateKnowledgeInput,
  type CreateKnowledgeVersionInput,
  type KnowledgeLifecycleInput,
  type KnowledgeSearchInput,
  type KnowledgeSearchResult,
} from './services/knowledge.service.js';

export {
  buildKnowledgeContext,
  type KnowledgeContextItem,
  type KnowledgeContextBuildInput,
  type KnowledgeContextBuildResult,
} from './services/context-builder.js';

export {
  KnowledgeEventLog,
  createKnowledgeEventLog,
  KnowledgeAuditEventType,
  knowledgeCategoryForType,
  knowledgeSeverityForType,
  knowledgeSourceForType,
  type KnowledgeEvent,
  type StoredKnowledgeEvent,
  type KnowledgeEventSource,
  type KnowledgeEventSeverity,
  type KnowledgeEventCategory,
  type KnowledgeEventPage,
  type KnowledgeEventFilter,
  type KnowledgeEventQuery,
  type KnowledgeEventLogOptions,
} from './events/index.js';

export { KnowledgeConfigSchema, type KnowledgeConfig } from './config/schema.js';

export { parseKnowledgeConfig } from './config/index.js';

export { computeContentHash, hashesMatch } from './utils/checksum.js';

export {
  createKnowledgeId,
  createKnowledgeVersionId,
  createChunkId,
  createTraceId,
  createRequestId,
  nowIso,
} from './utils/ids.js';

export { SystemClock, FixedClock, clockToIso, type KnowledgeClock } from './clock/index.js';

export {
  assertNonEmpty,
  assertContentWithinLimits,
  assertMetadataWithinLimits,
  sizeLimitsFromConfig,
} from './validators/index.js';
