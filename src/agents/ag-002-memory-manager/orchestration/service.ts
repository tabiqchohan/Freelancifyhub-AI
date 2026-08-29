import type { EventLogContract, MemoryEvent, MemoryEventEmitter } from '../events/index.js';
import { InMemoryMemoryEventEmitter, MemoryEventType } from '../events/index.js';
import type { MemoryConfig } from '../config/schema.js';
import { memoryConfig } from '../config/index.js';
import { MemorySecurityLevel } from '../enums/index.js';
import type { MemoryActor } from '../security/index.js';
import type { RetrievalRequest } from '../retrieval/index.js';
import { createTraceId } from '../utils/ids.js';
import { withTimeout, isCancelled } from './timeout.js';
import { MemoryIntegrationError, MemoryIntegrationErrorCategory } from './error.js';
import type {
  MemoryContextResult,
  MemoryFetchResult,
  OrchestrationMemorySection,
} from './contracts.js';
import {
  MemoryContextStatus,
  type OrchestrationMemoryCapabilities,
  type OrchestrationMemoryRequest,
} from './contracts.js';
import type {
  OrchestrationMemoryMetricSink,
  OrchestrationMemoryMetricsSnapshot,
} from './metrics-types.js';
import type { MemoryManagerContract } from './manager-interface.js';
import type { OrchestrationMemoryHealth } from './health.js';
import { buildIntegrationHealth, buildCapabilities } from './health.js';

/**
 * Sprint 8 â€” Master Orchestrator memory integration service (prompt Â§1â€“Â§21).
 *
 * The in-process seam AG-001 calls to request memory context for an
 * orchestration request. It maps AG-001 correlation/actor fields, runs the
 * real AG-002 retrieval pipeline once, then the real ContextIntegrationService,
 * under bounded timeouts; emits correlated audit events; and returns a clean,
 * secret-free {@link MemoryContextResult}. Dependency-injected, deterministic,
 * fail-closed, and never touches repository/storage internals.
 */
export interface OrchestrationMemoryServiceOptions {
  readonly contract: MemoryManagerContract;
  readonly events?: MemoryEventEmitter;
  readonly eventLog?: EventLogContract | null;
  readonly config?: MemoryConfig;
  readonly metrics: OrchestrationMemoryMetricSink;
  readonly logger?: { info(o: object, msg: string): void };
  readonly now?: () => string;
}

export interface OrchestrationMemoryService {
  readonly name: string;
  readonly version: string;
  fetchMemoryContext(request: OrchestrationMemoryRequest): Promise<MemoryContextResult>;
  health(): OrchestrationMemoryHealth;
  capabilities(): OrchestrationMemoryCapabilities;
  metrics(): OrchestrationMemoryMetricsSnapshot;
}

export class OrchestrationMemoryServiceImpl implements OrchestrationMemoryService {
  readonly name = 'orchestration-memory-service';
  readonly version = '1.0.0';

  private readonly contract: MemoryManagerContract;
  private readonly events: MemoryEventEmitter;
  private readonly eventLog: EventLogContract | null;
  private readonly config: MemoryConfig;
  private readonly metricsSink: OrchestrationMemoryMetricSink;
  private readonly logger: { info(o: object, msg: string): void };
  private readonly now: () => string;

  constructor(options: OrchestrationMemoryServiceOptions) {
    this.contract = options.contract;
    this.events = options.events ?? new InMemoryMemoryEventEmitter();
    this.eventLog = options.eventLog ?? null;
    this.config = options.config ?? memoryConfig;
    this.metricsSink = options.metrics;
    this.logger = options.logger ?? { info: () => undefined };
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async fetchMemoryContext(request: OrchestrationMemoryRequest): Promise<MemoryContextResult> {
    const traceId = request.traceId ?? createTraceId();

    if (isCancelled(request.isCancelled)) {
      this.metricsSink.recordStatus(MemoryContextStatus.Unavailable);
      return this.disabledResult(request, traceId, MemoryContextStatus.Unavailable, [
        'request cancelled before memory fetch',
      ]);
    }

    const status = this.integrationStatus(request);
    if (status !== MemoryContextStatus.Available) {
      this.metricsSink.recordStatus(status);
      this.metricsSink.recordUnavailable();
      this.emitReadEvent(request, traceId, status, 0);
      return this.emptyResultFor(request, traceId, status);
    }

    // Step 1: bounded retrieval via the real AG-002 retrieval pipeline (once).
    const fetch = await this.runFetch(request, traceId);

    // Step 2: bounded context assembly via the real ContextIntegrationService.
    const assembly = await this.runContextAssembly(request, fetch, traceId);

    const finalStatus =
      fetch.status === MemoryContextStatus.Available
        ? assembly.recordCount === 0
          ? MemoryContextStatus.Empty
          : MemoryContextStatus.Available
        : fetch.status;

    this.metricsSink.recordStatus(finalStatus);
    this.emitReadEvent(request, traceId, finalStatus, assembly.recordCount);

    return this.toResult(request, traceId, finalStatus, assembly, fetch);
  }

  private async runFetch(
    request: OrchestrationMemoryRequest,
    traceId: string,
  ): Promise<MemoryFetchResult> {
    this.metricsSink.recordRetrievalStarted();
    try {
      const response = await withTimeout(
        () => this.contract.retrieveService(this.toRetrievalRequest(request, traceId)),
        this.config.MEMORY_ORCHESTRATOR_RETRIEVAL_TIMEOUT_MS,
      );
      this.metricsSink.recordRetrievalSuccess(
        response.results.length,
        response.metadata.durationMs,
      );
      this.logger.info(
        { traceId, count: response.results.length, truncation: response.metadata.truncated },
        'orchestration memory retrieval completed',
      );
      return {
        status: MemoryContextStatus.Available,
        results: response.results,
        recordCount: response.results.length,
        warnings: [],
        timedOut: false,
        truncation: response.metadata.truncated,
      };
    } catch (error) {
      this.metricsSink.recordRetrievalFailure();
      const status = this.toStatus(error);
      this.metricsSink.recordStatus(status);
      this.logger.info({ traceId, status }, 'orchestration memory retrieval failed');
      return {
        status,
        results: [],
        recordCount: 0,
        warnings: [this.safeMessage(status)],
        timedOut: status === MemoryContextStatus.Timeout,
        truncation: false,
      };
    }
  }

  private async runContextAssembly(
    request: OrchestrationMemoryRequest,
    fetch: MemoryFetchResult,
    traceId: string,
  ): Promise<{
    sections: readonly OrchestrationMemorySection[];
    recordCount: number;
    tokenCount: number;
    truncated: boolean;
  }> {
    if (fetch.status !== MemoryContextStatus.Available || fetch.results.length === 0) {
      return { sections: [], recordCount: 0, tokenCount: 0, truncated: false };
    }
    if (isCancelled(request.isCancelled)) {
      this.metricsSink.recordStatus(MemoryContextStatus.Unavailable);
      return { sections: [], recordCount: 0, tokenCount: 0, truncated: false };
    }
    try {
      const response = await withTimeout(
        () =>
          this.contract.buildContext({
            actor: request.actor,
            results: fetch.results,
            contextBudgetTokens: request.contextBudgetTokens,
            maxRecordsPerSection: request.maxRecordsPerSection,
            snippetLength: request.snippetLength,
            traceId,
          }),
        this.config.MEMORY_ORCHESTRATOR_CONTEXT_TIMEOUT_MS,
      );
      const count = response.sections.reduce((sum, s) => sum + s.records.length, 0);
      this.metricsSink.recordContextSupplied(count);
      if (response.metadata.truncated) this.metricsSink.recordContextTruncation();
      this.logger.info(
        { traceId, count, truncation: response.metadata.truncated },
        'orchestration context assembly completed',
      );
      return {
        sections: response.sections.map((section) => ({
          type: section.type,
          priority: section.priority,
          records: section.records.map((r) => ({
            id: r.id,
            namespace: r.namespace,
            key: r.key,
            type: r.type,
            priority: r.priority,
            securityLevel: r.securityLevel,
            snippet: r.snippet,
            tokenEstimate: r.tokenEstimate,
            version: r.version,
          })),
          tokenEstimate: section.tokenEstimate,
          truncated: section.truncated,
        })),
        recordCount: count,
        tokenCount: response.statistics.estimatedTokens,
        truncated: response.metadata.truncated,
      };
    } catch (error) {
      const status = this.toStatus(error);
      this.metricsSink.recordStatus(status);
      this.logger.info({ traceId, status }, 'orchestration context assembly failed');
      return { sections: [], recordCount: 0, tokenCount: 0, truncated: false };
    }
  }

  private toRetrievalRequest(
    request: OrchestrationMemoryRequest,
    traceId: string,
  ): RetrievalRequest {
    return {
      actor: request.actor,
      query: request.query,
      namespace: request.namespace,
      types: request.types,
      priorities: request.priorities,
      contextBudgetTokens: request.contextBudgetTokens,
      maxResults: this.retrievalLimit(request),
      traceId,
    };
  }

  private retrievalLimit(request: OrchestrationMemoryRequest): number | undefined {
    const perSection = request.maxRecordsPerSection ?? 20;
    const sections = request.maxSections ?? 8;
    if (request.maxSections !== undefined || request.maxRecordsPerSection !== undefined) {
      return sections * perSection;
    }
    return undefined;
  }

  private integrationStatus(request: OrchestrationMemoryRequest): MemoryContextStatus {
    if (!this.config.MEMORY_ORCHESTRATOR_INTEGRATION_ENABLED) {
      return MemoryContextStatus.Disabled;
    }
    if (
      !request.actor ||
      !request.actor.group ||
      !request.actor.namespaces ||
      request.actor.namespaces.length === 0
    ) {
      this.metricsSink.recordAuthorizationDenial();
      return MemoryContextStatus.SecurityDenied;
    }
    if (!this.contract.health().ok) {
      return MemoryContextStatus.Unavailable;
    }
    return MemoryContextStatus.Available;
  }

  private toResult(
    request: OrchestrationMemoryRequest,
    traceId: string,
    status: MemoryContextStatus,
    assembly: {
      sections: readonly OrchestrationMemorySection[];
      recordCount: number;
      tokenCount: number;
      truncated: boolean;
    },
    fetch: MemoryFetchResult,
  ): MemoryContextResult {
    return {
      enabled: this.config.MEMORY_ORCHESTRATOR_INTEGRATION_ENABLED,
      status,
      sections: assembly.sections,
      recordCount: assembly.recordCount,
      tokenCount: assembly.tokenCount,
      truncated: assembly.truncated,
      traceId,
      requestId: request.requestId,
      executionId: request.executionId,
      correlationId: request.correlationId,
      warnings: [...fetch.warnings, ...(assembly.truncated ? ['context truncated'] : [])],
    };
  }

  private emptyResultFor(
    request: OrchestrationMemoryRequest,
    traceId: string,
    status: MemoryContextStatus,
  ): MemoryContextResult {
    return this.toResult(
      request,
      traceId,
      status,
      {
        sections: [],
        recordCount: 0,
        tokenCount: 0,
        truncated: false,
      },
      {
        status,
        results: [],
        recordCount: 0,
        warnings: [this.safeMessage(status)],
        timedOut: false,
        truncation: false,
      },
    );
  }

  private disabledResult(
    request: OrchestrationMemoryRequest,
    traceId: string,
    status: MemoryContextStatus,
    warnings: string[],
  ): MemoryContextResult {
    return {
      enabled: this.config.MEMORY_ORCHESTRATOR_INTEGRATION_ENABLED,
      status,
      sections: [],
      recordCount: 0,
      tokenCount: 0,
      truncated: false,
      traceId,
      requestId: request.requestId,
      executionId: request.executionId,
      correlationId: request.correlationId,
      warnings,
    };
  }

  private toStatus(error: unknown): MemoryContextStatus {
    if (error instanceof MemoryIntegrationError) {
      switch (error.category) {
        case MemoryIntegrationErrorCategory.Timeout:
          return MemoryContextStatus.Timeout;
        case MemoryIntegrationErrorCategory.Authorization:
          this.metricsSink.recordAuthorizationDenial();
          return MemoryContextStatus.SecurityDenied;
        case MemoryIntegrationErrorCategory.InvalidResponse:
          return MemoryContextStatus.InvalidResponse;
        case MemoryIntegrationErrorCategory.Cancellation:
          return MemoryContextStatus.Unavailable;
        default:
          return MemoryContextStatus.Unavailable;
      }
    }
    const message =
      error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    if (message.includes('timeout')) return MemoryContextStatus.Timeout;
    if (
      message.includes('denied') ||
      message.includes('unauthorized') ||
      message.includes('scope')
    ) {
      this.metricsSink.recordAuthorizationDenial();
      return MemoryContextStatus.SecurityDenied;
    }
    if (message.includes('invalid')) return MemoryContextStatus.InvalidResponse;
    return MemoryContextStatus.Unavailable;
  }

  private safeMessage(status: MemoryContextStatus): string {
    switch (status) {
      case MemoryContextStatus.Disabled:
        return 'memory integration disabled';
      case MemoryContextStatus.Unavailable:
        return 'memory integration unavailable';
      case MemoryContextStatus.SecurityDenied:
        return 'memory access denied for actor scope';
      case MemoryContextStatus.Timeout:
        return 'memory operation timed out';
      case MemoryContextStatus.InvalidResponse:
        return 'memory integration returned an invalid response';
      default:
        return '';
    }
  }

  private emitReadEvent(
    request: OrchestrationMemoryRequest,
    traceId: string,
    status: MemoryContextStatus,
    recordCount: number,
  ): void {
    const event: MemoryEvent = {
      type: MemoryEventType.Retrieved,
      traceId,
      occurredAt: this.now(),
      namespace: request.namespace,
      key: 'orchestration-fetch',
      actorId: request.actor.id,
      actorType: request.actor.type,
      actorGroup: request.actor.group,
      requestId: request.requestId,
      correlationId: request.correlationId,
      count: recordCount,
      source: 'memory',
      service: this.name,
      category: 'retrieval',
      severity: recordCount === 0 ? 'warning' : 'info',
      metadata: { status },
    };
    this.events.emit(event);
    this.eventLog?.append(event);
  }

  health(): OrchestrationMemoryHealth {
    return buildIntegrationHealth(
      {
        enabled: this.config.MEMORY_ORCHESTRATOR_INTEGRATION_ENABLED,
        retrievalServiceAvailable: this.contract.health().ok,
        contextIntegrationAvailable: this.contract.health().ok,
        eventLog: this.eventLog,
        storageAvailable: this.contract.health().storageAvailable,
      },
      this.now(),
    );
  }

  capabilities(): OrchestrationMemoryCapabilities {
    return buildCapabilities(this.health(), this.config.MEMORY_ORCHESTRATOR_WRITE_BACK);
  }

  metrics() {
    return this.metricsSink.snapshot();
  }
}

/** Creates an {@link OrchestrationMemoryService}. */
export function createOrchestrationMemoryService(
  options: OrchestrationMemoryServiceOptions,
): OrchestrationMemoryService {
  return new OrchestrationMemoryServiceImpl(options);
}

/** Builds a fail-closed {@link MemoryActor} from AG-001 actor fields. */
export function requireActor(
  actor: {
    id?: string;
    type?: string;
    role?: string;
    organizationId?: string;
    workspaceId?: string;
    projectIds?: readonly string[];
    securityClearance?: string;
    namespaces?: readonly string[];
  },
  group: string,
): MemoryActor | undefined {
  if (!actor || !actor.namespaces || actor.namespaces.length === 0) {
    return undefined;
  }
  return {
    group: group as MemoryActor['group'],
    id: actor.id,
    type: actor.type,
    role: actor.role,
    organizationId: actor.organizationId,
    workspaceId: actor.workspaceId,
    projectIds: actor.projectIds,
    securityClearance:
      (actor.securityClearance as MemorySecurityLevel) ?? MemorySecurityLevel.Internal,
    namespaces: actor.namespaces,
  };
}
