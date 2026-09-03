import type { KnowledgeManagerService } from '../../../ag-003-knowledge-manager/index.js';
import type { KnowledgeActorGroup } from '../../../ag-003-knowledge-manager/enums/index.js';
import type { KnowledgeNamespace } from '../../../ag-003-knowledge-manager/types/index.js';
import type { KnowledgeContextProvider } from '../interfaces/providers.js';
import type { ContextItem } from '../types/index.js';
import { ContextPriority, ContextSectionType, ContextSourceType } from '../types/index.js';

/**
 * AG-001 adapter for AG-003 knowledge context. Implements the
 * KnowledgeContextProvider interface so AG-001 can request knowledge context
 * through a clean interface without depending on AG-003 implementation.
 */

/** Input for loading knowledge context. */
export interface KnowledgeContextLoadInput {
  readonly requestId?: string;
  readonly traceId?: string;
  readonly actorGroup: KnowledgeActorGroup;
  readonly actorId?: string;
  readonly namespaces: readonly KnowledgeNamespace[];
  readonly query?: string;
  readonly maxResults?: number;
  readonly contextBudgetTokens?: number;
}

/** Options for constructing a KnowledgeContextProviderAdapter. */
export interface KnowledgeContextProviderAdapterOptions {
  readonly knowledgeService: KnowledgeManagerService;
}

export class KnowledgeContextProviderAdapter implements KnowledgeContextProvider {
  readonly source = ContextSourceType.KNOWLEDGE;

  private readonly knowledgeService: KnowledgeManagerService;

  constructor(options: KnowledgeContextProviderAdapterOptions) {
    this.knowledgeService = options.knowledgeService;
  }

  async load(input?: KnowledgeContextLoadInput): Promise<readonly ContextItem[]> {
    if (!input || input.namespaces.length === 0) {
      return [];
    }

    try {
      const searchResult = await this.knowledgeService.search({
        query: input.query ?? '',
        namespace: input.namespaces[0] ?? 'default',
        actorGroup: input.actorGroup,
        actorId: input.actorId,
        maxResults: input.maxResults ?? 10,
        namespaces: input.namespaces,
      });

      return searchResult.documents.map((doc, index): ContextItem => ({
        id: doc.id,
        source: { type: ContextSourceType.KNOWLEDGE, id: doc.id },
        section: ContextSectionType.KNOWLEDGE,
        content: `[${doc.title}] ${doc.content.slice(0, 200)}`,
        priority: ContextPriority.NORMAL,
        metadata: {
          namespace: doc.namespace,
          version: doc.version,
          sourceType: doc.source.sourceType,
        } satisfies Record<string, string | number | boolean>,
        order: index,
      }));
    } catch {
      return [];
    }
  }
}

/** Creates a KnowledgeContextProviderAdapter. */
export function createKnowledgeContextProvider(
  options: KnowledgeContextProviderAdapterOptions,
): KnowledgeContextProviderAdapter {
  return new KnowledgeContextProviderAdapter(options);
}
