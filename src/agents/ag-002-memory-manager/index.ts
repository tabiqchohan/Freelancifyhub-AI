/**
 * AG-002 Shared Memory Manager — public barrel (Sprint 1 foundation).
 */

export * from './enums/index.js';
export * from './types/index.js';
export * from './errors/index.js';
export * from './schemas/index.js';
export * from './validators/index.js';
export * from './lifecycle/index.js';
export * from './security/index.js';
export * from './retention/index.js';
export * from './classification/index.js';
export * from './storage/index.js';
export * from './repositories/index.js';
export * from './cache/index.js';
export * from './retrieval/index.js';
export * from './events/index.js';
export * from './clock/index.js';
export * from './orchestration/index.js';
export * from './utils/ids.js';

export { InMemoryStorageAdapter } from './storage/in-memory.js';
export { InMemoryMemoryRepository } from './repositories/in-memory.js';
export { InMemoryMemoryRetrievalEngine } from './retrieval/in-memory.js';

export { PostgresStorageAdapter, createPostgresPool } from './storage/postgres.js';
export {
  createPostgresAdapter,
  registerPostgresBackend,
  buildPostgresBackend,
  resolvePostgresConnectionString,
  MEMORY_DATABASE_URL_ENV,
} from './storage/postgres-backend.js';
export { PostgresMemoryRepository } from './repositories/postgres.js';
export {
  migrateSchema,
  SCHEMA_VERSION,
  pendingMigrations,
  SCHEMA_MIGRATIONS,
} from './storage/schema.js';
export { PostgresEventSink } from './events/postgres.js';

export { MemoryConfigSchema } from './config/schema.js';
export type { MemoryConfig } from './config/schema.js';
export { parseMemoryConfig, memoryConfig } from './config/index.js';

export { createMemoryLogger } from './utils/logger.js';
export { sanitizeMemoryRecordForLogs, isLikelySecret } from './utils/sanitize.js';
export { serializeMemoryRecord, parseMemoryRecord } from './utils/serialization.js';

export { MemoryManagerService, createMemoryManagerService } from './services/memory.service.js';
export type {
  MemoryManager,
  MemoryManagerServiceDependencies,
  MemoryManagerServiceOptions,
  CreateMemoryInput,
  GetMemoryInput,
  UpdateMemoryInput,
  DeleteMemoryInput,
  DeleteMemoryResult,
  ArchiveMemoryInput,
  RestoreMemoryInput,
  EraseMemoryByIdInput,
  EraseMemoryByNamespaceInput,
  EraseMemoryResult,
  RetrieveMemoryInput,
} from './services/memory.service.js';

export {
  MemoryLifecycleServiceImpl,
  createMemoryLifecycleService,
} from './services/lifecycle.service.js';
export type {
  MemoryLifecycleService,
  MemoryLifecycleServiceDependencies,
  MemoryLifecycleServiceOptions,
  MemoryLifecycleInput,
  MemoryLifecycleRunInput,
  MemoryLifecycleBatchInput,
  MemoryLifecycleRunResult,
} from './services/lifecycle.service.js';

export {
  ContextIntegrationServiceImpl,
  createContextIntegrationService,
} from './services/context-integration.service.js';
export type {
  ContextIntegrationService,
  ContextIntegrationServiceOptions,
  ContextIntegrationRequest,
  ContextIntegrationPipelineConfig,
  ContextIntegrationResponse,
  ContextSection,
  ContextSectionRequest,
  ContextRecordEntry,
  ContextIntegrationStatistics,
  ContextIntegrationMetadata,
} from './services/context-integration.service.js';

export {
  MemoryConsolidationServiceImpl,
  createMemoryConsolidationService,
} from './services/consolidation.service.js';
export type {
  MemoryConsolidationService,
  MemoryConsolidationServiceOptions,
  MemoryConsolidationRequest,
  MemoryConsolidationPolicy,
  MemoryConsolidationGroup,
  MemoryConsolidationCandidateResult,
  MemoryConsolidationEvaluation,
  MemoryConsolidationResult,
  MemoryConsolidationStatistics,
} from './services/consolidation.service.js';

export {
  MemoryReplayServiceImpl,
  createMemoryReplayService,
  replayMemoryStream,
} from './services/replay.service.js';
export type {
  MemoryReplayInput,
  MemoryReplayNamespaceInput,
  MemoryReplayResult,
  MemoryReplayService,
  MemoryReplayServiceOptions,
  MemoryReplayStartState,
  MemoryReplayState,
} from './services/replay.service.js';

export {
  MemoryIdempotencyRegistry,
  memoryCreateFingerprint,
  stableStringDigest,
  MemoryIdempotencyValidationError,
} from './services/idempotency.js';

export { RetrievalServiceImpl, createRetrievalService } from './services/retrieval.service.js';
export type { RetrievalServiceOptions } from './retrieval/index.js';
