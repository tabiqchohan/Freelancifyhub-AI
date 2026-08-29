import type { ContextIntegrationRequest } from '../services/context-integration.service.js';
import type {
  MemoryConsolidationRequest,
  MemoryConsolidationResult,
} from '../services/consolidation.service.js';
import type {
  RetrievalRequest,
  RetrievalResponse,
  MemoryRetrievalResult,
} from '../retrieval/index.js';
import type {
  ArchiveMemoryInput,
  CreateMemoryInput,
  DeleteMemoryInput,
  DeleteMemoryResult,
  GetMemoryInput,
  RetrieveMemoryInput,
  UpdateMemoryInput,
} from '../services/memory.service.js';
import type { MemoryActor } from '../security/index.js';
import type { MemoryRecordFilter, MemoryNamespace, MemoryRecord } from '../types/index.js';
import type { ContextIntegrationResponse } from '../services/context-integration.service.js';

/**
 * Sprint 8 â€” narrow memory capability contract (prompt Â§2).
 *
 * The single seam AG-001 may depend on. It reuses AG-002's real service
 * contracts and never exposes repository/storage internals. AG-001 never sees
 * the implementation classes; it only depends on this interface (via the
 * adapter) and on the integration service.
 */
export interface MemoryManagerContract {
  readonly name: string;

  /** Authorized, ranked retrieval (MemoryManager.retrieveMemory). */
  retrieve(input: RetrieveMemoryInput): Promise<readonly MemoryRetrievalResult[]>;

  /** Full retrieval pipeline (RetrievalService.retrieve). */
  retrieveService(input: RetrievalRequest): Promise<RetrievalResponse>;

  /** Reuse ContextIntegrationService to assemble deterministic context. */
  buildContext(input: ContextIntegrationRequest): Promise<ContextIntegrationResponse>;

  createMemory(input: CreateMemoryInput): Promise<MemoryRecord>;
  updateMemory(input: UpdateMemoryInput): Promise<MemoryRecord>;
  deleteMemory(input: DeleteMemoryInput): Promise<DeleteMemoryResult>;
  archiveMemory(input: ArchiveMemoryInput): Promise<MemoryRecord>;
  getMemory(input: GetMemoryInput): Promise<MemoryRecord>;

  /** Restore an archived memory via the real lifecycle transition (Sprint 9). */
  restoreMemory(input: {
    actor: MemoryActor;
    namespace: MemoryNamespace;
    key: string;
    reason: string;
    traceId?: string;
  }): Promise<MemoryRecord>;

  /** Bounded, authorized record query (never exposes repository directly). */
  queryMemory(input: {
    actor: MemoryActor;
    namespace: MemoryNamespace;
    filter?: MemoryRecordFilter;
    limit?: number;
    traceId?: string;
  }): Promise<readonly MemoryRecord[]>;

  consolidate(input: MemoryConsolidationRequest): Promise<MemoryConsolidationResult>;

  health(): MemoryManagerContractHealth;
  capabilities(): MemoryManagerContractCapabilities;
}

/** Truthful capability reporting for the memory contract (prompt Â§14). */
export interface MemoryManagerContractCapabilities {
  readonly name: string;
  readonly capabilities: readonly string[];
}

/** Truthful, secret-free health for the memory contract. */
export interface MemoryManagerContractHealth {
  readonly ok: boolean;
  readonly storageAvailable: boolean;
  readonly availableCapabilities: readonly string[];
  readonly message: string;
}
