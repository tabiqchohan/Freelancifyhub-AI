import type { MemoryManager } from '../services/memory.service.js';
import type { ContextIntegrationService } from '../services/context-integration.service.js';
import type { ContextIntegrationRequest } from '../services/context-integration.service.js';
import type { MemoryConsolidationService } from '../services/consolidation.service.js';
import type { RetrievalService } from '../retrieval/index.js';
import type { MemoryManagerContract } from './manager-interface.js';

/**
 * Sprint 8 — {@link MemoryManagerContract} adapter (prompt §2).
 *
 * A narrow capability contract for AG-001 that reuses AG-002's real services
 * (MemoryManager, RetrievalService, ContextIntegrationService,
 * MemoryConsolidationService) and never exposes repository or storage internals.
 * Read paths are authorized by the real services; the adapter only translates
 * calls.
 */
export class MemoryManagerContractAdapter implements MemoryManagerContract {
  readonly name = 'memory-manager-integration-contract';

  private readonly manager: MemoryManager;
  private readonly retrieval: RetrievalService;
  private readonly contextIntegration: ContextIntegrationService;
  private readonly consolidation: MemoryConsolidationService;
  private readonly storageAvailable: boolean;

  constructor(options: {
    manager: MemoryManager;
    retrieval: RetrievalService;
    contextIntegration: ContextIntegrationService;
    consolidation: MemoryConsolidationService;
    storageAvailable?: boolean;
  }) {
    this.manager = options.manager;
    this.retrieval = options.retrieval;
    this.contextIntegration = options.contextIntegration;
    this.consolidation = options.consolidation;
    this.storageAvailable = options.storageAvailable ?? true;
  }

  retrieve(input: Parameters<MemoryManager['retrieveMemory']>[0]) {
    return this.manager.retrieveMemory(input);
  }

  retrieveService(input: Parameters<RetrievalService['retrieve']>[0]) {
    return this.retrieval.retrieve(input);
  }

  buildContext(input: ContextIntegrationRequest) {
    return this.contextIntegration.integrate(input);
  }

  createMemory(input: Parameters<MemoryManager['createMemory']>[0]) {
    return this.manager.createMemory(input);
  }

  updateMemory(input: Parameters<MemoryManager['updateMemory']>[0]) {
    return this.manager.updateMemory(input);
  }

  deleteMemory(input: Parameters<MemoryManager['deleteMemory']>[0]) {
    return this.manager.deleteMemory(input);
  }

  archiveMemory(input: Parameters<MemoryManager['archiveMemory']>[0]) {
    return this.manager.archiveMemory(input);
  }

  getMemory(input: Parameters<MemoryManager['getMemory']>[0]) {
    return this.manager.getMemory(input);
  }

  /**
   * Restore an archived memory back to ACTIVE via the real lifecycle transition
   * (Sprint 9). Authorized by the real MemoryManager with the Restore permission.
   */
  restoreMemory(input: Parameters<MemoryManager['restoreMemory']>[0]) {
    return this.manager.restoreMemory(input);
  }

  async queryMemory(input: Parameters<MemoryManagerContract['queryMemory']>[0]) {
    const results = await this.manager.retrieveMemory({
      actor: input.actor,
      namespace: input.namespace,
      traceId: input.traceId,
      filters: input.filter,
      limit: input.limit,
    });
    return results.map((r) => r.record);
  }

  consolidate(input: Parameters<MemoryConsolidationService['consolidate']>[0]) {
    return this.consolidation.consolidate(input);
  }

  health() {
    const availableCapabilities = [
      'retrieve',
      'retrieveService',
      'buildContext',
      'createMemory',
      'updateMemory',
      'deleteMemory',
      'archiveMemory',
      'restoreMemory',
      'getMemory',
      'queryMemory',
      'consolidate',
      'health',
      'capabilities',
    ];
    return {
      ok: this.storageAvailable,
      storageAvailable: this.storageAvailable,
      availableCapabilities,
      message: this.storageAvailable
        ? 'memory manager contract available'
        : 'memory manager contract unavailable',
    };
  }

  capabilities() {
    return {
      name: this.name,
      capabilities: [
        'retrieve',
        'retrieveService',
        'buildContext',
        'createMemory',
        'updateMemory',
        'deleteMemory',
        'archiveMemory',
        'restoreMemory',
        'getMemory',
        'queryMemory',
        'consolidate',
        'health',
        'capabilities',
      ],
    };
  }
}
