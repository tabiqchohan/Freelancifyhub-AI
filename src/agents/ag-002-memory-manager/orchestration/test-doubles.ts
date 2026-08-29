import type { MemoryManagerContract } from './manager-interface.js';
import type { MemoryContextStatus } from './contracts.js';
import type {
  MemoryRetrievalResult,
  RetrievalRequest,
  RetrievalResponse,
  RetrievalResult,
} from '../retrieval/index.js';
import type { MemoryRecord } from '../types/index.js';
import type {
  ContextIntegrationResponse,
  ContextSection,
} from '../services/context-integration.service.js';
import type {
  MemoryConsolidationResult,
  MemoryConsolidationStatistics,
} from '../services/consolidation.service.js';

/** A controllable {@link MemoryManagerContract} double for deterministic orchestration tests. */
export class StubMemoryManagerContract implements MemoryManagerContract {
  readonly name = 'stub-memory-manager-contract';

  retrievalResults: readonly MemoryRetrievalResult[] = [];
  contextSections: readonly ContextSection[] = [];
  record: MemoryRecord | null = null;
  retrieveError: Error | null = null;
  buildContextError: Error | null = null;
  healthy = true;

  health() {
    return {
      ok: this.healthy,
      storageAvailable: this.healthy,
      availableCapabilities: this.healthy ? ['retrieve', 'buildContext'] : [],
      message: this.healthy ? 'stub contract healthy' : 'stub contract unhealthy',
    };
  }

  capabilities() {
    return { name: this.name, capabilities: this.healthy ? ['retrieve', 'buildContext'] : [] };
  }

  async retrieve() {
    if (this.retrieveError) throw this.retrieveError;
    return this.retrievalResults;
  }

  async retrieveService(input: RetrievalRequest): Promise<RetrievalResponse> {
    if (this.retrieveError) throw this.retrieveError;
    const hits: RetrievalResult[] = this.retrievalResults.map((r) => ({
      record: r.record,
      score: r.score,
      snippet: r.snippet,
    }));
    return {
      results: hits,
      statistics: {
        candidateCount: hits.length,
        authorizedCount: hits.length,
        selectedCount: hits.length,
        filteredCount: 0,
        truncatedCount: 0,
      },
      metadata: { traceId: input.traceId ?? 'stub', durationMs: 0, truncated: false },
    };
  }

  async buildContext(): Promise<ContextIntegrationResponse> {
    if (this.buildContextError) throw this.buildContextError;
    const selected = this.contextSections.reduce((n, s) => n + s.records.length, 0);
    return {
      sections: this.contextSections,
      statistics: {
        inputCount: selected,
        authorizedCount: selected,
        filteredCount: 0,
        duplicateCount: 0,
        selectedCount: selected,
        truncatedCount: 0,
        excludedCount: 0,
        estimatedTokens: 0,
        budget: 8192,
        sectionsGenerated: this.contextSections.length,
        processingDurationMs: 0,
      },
      metadata: { traceId: 'stub', durationMs: 0, truncated: false },
      sanitized: true,
      enabled: true,
    };
  }

  async createMemory() {
    if (!this.record) throw new Error('no record loaded');
    return this.record;
  }
  async updateMemory() {
    if (!this.record) throw new Error('no record loaded');
    return this.record;
  }
  async deleteMemory() {
    return { key: this.record?.key ?? '', status: 'deleted' as const };
  }
  async archiveMemory() {
    if (!this.record) throw new Error('no record loaded');
    return this.record;
  }
  async getMemory() {
    if (!this.record) throw new Error('no record loaded');
    return this.record;
  }
  async restoreMemory(): Promise<MemoryRecord> {
    throw new Error('stub restore unsupported');
  }
  async queryMemory() {
    return this.record ? [this.record] : [];
  }
  async consolidate(): Promise<MemoryConsolidationResult> {
    const statistics: MemoryConsolidationStatistics = {
      consolidationId: 'stub',
      namespace: 'user:1',
      candidatesDiscovered: 0,
      candidatesAuthorized: 0,
      candidatesRejected: 0,
      filteredByLifecycle: 0,
      filteredByScope: 0,
      filteredBySecurity: 0,
      filteredByType: 0,
      candidatesExcludedByLimit: 0,
      groupsFormed: 0,
      groupsConsolidated: 0,
      groupsSkipped: 0,
      recordsCreated: 0,
      recordsPreserved: 0,
      conflicts: 0,
      durationMs: 0,
    };
    return { enabled: true, records: [], statistics };
  }
}

/** Records orchestration observations for assertions. */
export class StubMetricSink {
  statuses: MemoryContextStatus[] = [];
  started = 0;
  successes = 0;
  failures = 0;
  denials = 0;
  supplied: number[] = [];
  truncations = 0;
  unavailable = 0;

  snapshot() {
    return {
      retrievalCount: this.started,
      retrievalSuccess: this.successes,
      retrievalFailure: this.failures,
      emptyRetrievals: 0,
      authorizationDenials: this.denials,
      contextRecordsSupplied: this.supplied.reduce((a, b) => a + b, 0),
      contextTruncations: this.truncations,
      retrievalDurationMs: 0,
      contextIntegrationDurationMs: 0,
      memoryUnavailableCount: this.unavailable,
      statusCounts: this.statuses.reduce<Record<string, number>>((acc, s) => {
        acc[s] = (acc[s] ?? 0) + 1;
        return acc;
      }, {}),
    };
  }
  recordRetrievalStarted() {
    this.started += 1;
  }
  recordRetrievalSuccess(_c: number) {
    this.successes += 1;
  }
  recordRetrievalFailure() {
    this.failures += 1;
  }
  recordEmptyRetrieval() {}
  recordAuthorizationDenial() {
    this.denials += 1;
  }
  recordContextSupplied(c: number) {
    this.supplied.push(c);
  }
  recordContextTruncation() {
    this.truncations += 1;
  }
  recordContextDuration(_ms: number) {}
  recordUnavailable() {
    this.unavailable += 1;
  }
  recordStatus(s: MemoryContextStatus) {
    this.statuses.push(s);
  }
}
