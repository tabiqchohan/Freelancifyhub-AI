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
export * from './retrieval/index.js';
export * from './events/index.js';
export * from './utils/ids.js';

export { InMemoryStorageAdapter } from './storage/in-memory.js';
export { InMemoryMemoryRepository } from './repositories/in-memory.js';
export { InMemoryMemoryRetrievalEngine } from './retrieval/in-memory.js';

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
  RetrieveMemoryInput,
} from './services/memory.service.js';
