import { MemoryPriority } from '../../../ag-002-memory-manager/index.js';
import type {
  ContextIntegrationResponse,
  ContextSection,
  MemoryActor,
  MemoryManagerContract,
  RetrievalResult,
} from '../../../ag-002-memory-manager/index.js';
import type { MemoryContextLoadInput, MemoryContextProvider } from '../interfaces/providers.js';
import type { ContextItem } from '../types/index.js';
import { ContextPriority, ContextSectionType, ContextSourceType } from '../types/index.js';

/**
 * Sprint 11 — AG-001 runtime wiring to AG-002 (prompt32 PHASE 1/2).
 *
 * Adapter implementing AG-001's {@link MemoryContextProvider} in terms of the
 * AG-002 {@link MemoryManagerContract}. AG-001 implements its own provider
 * interface; it never depends on AG-002 implementation classes directly. The
 * dependency is one-way (AG-001 -> AG-002); AG-002 never imports AG-001, so
 * there is no circular dependency.
 *
 * Flow: for each requested namespace, run the authorized retrieval pipeline
 * (`retrieveService`), aggregate the deterministic `RetrievalResult`s, then
 * assemble them via `buildContext` (redacted snippets, dedup, priority
 * ordering, budget enforcement) and map the resulting `ContextSection`s to
 * AG-001 `ContextItem`s.
 */
export interface MemoryContextProviderAdapterOptions {
  /** The AG-002 memory contract (the single seam AG-001 may depend on). */
  readonly contract: MemoryManagerContract;
}

export class MemoryContextProviderAdapter implements MemoryContextProvider {
  readonly source = ContextSourceType.MEMORY;

  private readonly contract: MemoryManagerContract;

  constructor(options: MemoryContextProviderAdapterOptions) {
    this.contract = options.contract;
  }

  async load(input?: MemoryContextLoadInput): Promise<readonly ContextItem[]> {
    if (!input || input.namespaces.length === 0) {
      return [];
    }

    const actor: MemoryActor = this.toActor(input);

    const results = await this.retrieveAcrossNamespaces(actor, input);

    const context = await this.contract.buildContext({
      actor,
      results,
      contextBudgetTokens: input.contextBudgetTokens,
      maxRecordsPerSection: input.maxRecordsPerSection,
      snippetLength: input.snippetLength,
      traceId: input.traceId,
    });

    return this.mapToContextItems(context);
  }

  private toActor(input: MemoryContextLoadInput): MemoryActor {
    return {
      group: input.actorGroup,
      id: input.actorId,
      role: input.actorRole,
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      projectIds: input.projectIds,
      securityClearance: input.securityClearance,
      namespaces: [...input.namespaces],
    };
  }

  private async retrieveAcrossNamespaces(
    actor: MemoryActor,
    input: MemoryContextLoadInput,
  ): Promise<readonly RetrievalResult[]> {
    const results: RetrievalResult[] = [];
    for (const namespace of input.namespaces) {
      const response = await this.contract.retrieveService({
        actor,
        namespace,
        query: input.query,
        maxResults: input.maxResults,
        contextBudgetTokens: input.contextBudgetTokens,
        traceId: input.traceId,
      });
      results.push(...response.results);
    }
    return results;
  }

  private mapToContextItems(context: ContextIntegrationResponse): readonly ContextItem[] {
    const items: ContextItem[] = [];
    let order = 0;
    for (const section of context.sections) {
      this.mapSection(section, items, order);
      order += section.records.length;
    }
    return items;
  }

  private mapSection(section: ContextSection, items: ContextItem[], orderOffset: number): void {
    section.records.forEach((entry, index) => {
      items.push({
        id: `${entry.namespace}:${entry.key}:${entry.version}`,
        source: { type: ContextSourceType.MEMORY, id: entry.namespace },
        section: ContextSectionType.MEMORY,
        content: entry.snippet,
        priority: this.mapPriority(entry.priority),
        metadata: {
          recordId: entry.id,
          namespace: entry.namespace,
          key: entry.key,
          type: entry.type,
          securityLevel: entry.securityLevel,
          tokenEstimate: entry.tokenEstimate,
          version: entry.version,
        },
        order: orderOffset + index,
      });
    });
  }

  private mapPriority(priority: MemoryPriority): ContextPriority {
    switch (priority) {
      case MemoryPriority.Critical:
        return ContextPriority.CRITICAL;
      case MemoryPriority.High:
        return ContextPriority.HIGH;
      case MemoryPriority.Medium:
        return ContextPriority.NORMAL;
      default:
        return ContextPriority.LOW;
    }
  }
}

/** Creates an AG-001 {@link MemoryContextProvider} backed by an AG-002 contract. */
export function createMemoryContextProvider(
  options: MemoryContextProviderAdapterOptions,
): MemoryContextProvider {
  return new MemoryContextProviderAdapter(options);
}
