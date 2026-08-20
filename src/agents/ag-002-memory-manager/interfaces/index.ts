/** Single import surface for AG-002 contract interfaces (prompt §15, §25). */

export type { MemoryEvent, MemoryEventEmitter, MemoryEventType } from '../events/index.js';
export type { MemoryLifecycleContract } from '../lifecycle/index.js';
export type { MemoryRepository } from '../repositories/index.js';
export type {
  MemoryRetrievalEngine,
  MemoryRetrievalQuery,
  MemoryRetrievalResult,
} from '../retrieval/index.js';
export type {
  MemoryAccessCheckInput,
  MemoryAccessCheckTarget,
  MemoryAccessPolicy,
  MemoryActor,
} from '../security/index.js';
export type { MemoryStorageAdapter } from '../storage/index.js';
export type {
  ArchiveMemoryInput,
  CreateMemoryInput,
  DeleteMemoryInput,
  DeleteMemoryResult,
  GetMemoryInput,
  MemoryManager,
  MemoryManagerServiceDependencies,
  MemoryManagerServiceOptions,
  RetrieveMemoryInput,
  UpdateMemoryInput,
} from '../services/memory.service.js';
