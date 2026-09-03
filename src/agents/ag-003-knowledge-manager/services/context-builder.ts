import type { KnowledgeDocument, KnowledgeNamespace } from '../types/index.js';
import type { KnowledgeActorGroup } from '../enums/index.js';
import type { KnowledgeAuthorizationService } from '../security/index.js';
import { KnowledgePermission } from '../enums/index.js';

/**
 * KnowledgeContextBuilder — converts knowledge documents into AG-001-compatible
 * context items. Reuses AG-001's shared abstractions where possible.
 */

/** A single knowledge context item for AG-001. */
export interface KnowledgeContextItem {
  readonly id: string;
  readonly source: 'knowledge';
  readonly section: 'knowledge';
  readonly content: string;
  readonly priority: 'high' | 'normal' | 'low';
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
  readonly order?: number;
}

/** Input for building knowledge context. */
export interface KnowledgeContextBuildInput {
  readonly documents: readonly KnowledgeDocument[];
  readonly actorGroup: KnowledgeActorGroup;
  readonly actorId?: string;
  readonly namespaces: readonly KnowledgeNamespace[];
  readonly maxResults?: number;
  readonly contextBudgetTokens?: number;
  readonly snippetLength?: number;
  readonly authorizationService: KnowledgeAuthorizationService;
}

/** The output of a knowledge context build. */
export interface KnowledgeContextBuildResult {
  readonly items: readonly KnowledgeContextItem[];
  readonly estimatedTokens: number;
  readonly filteredCount: number;
  readonly includedCount: number;
}

/** Simple token estimator (characters / 4). */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Builds AG-001-compatible context items from knowledge documents.
 * Performs authorization filtering, deduplication, priority-aware selection,
 * and token budget enforcement.
 */
export function buildKnowledgeContext(
  input: KnowledgeContextBuildInput,
): KnowledgeContextBuildResult {
  const maxResults = input.maxResults ?? 20;
  const snippetLength = input.snippetLength ?? 200;
  const contextBudgetTokens = input.contextBudgetTokens ?? 4096;

  const allItems: KnowledgeContextItem[] = [];
  const seenContentHashes = new Set<string>();
  let filteredCount = 0;

  for (const doc of input.documents) {
    // Authorization check
    const decision = input.authorizationService.authorize({
      actor: {
        group: input.actorGroup,
        id: input.actorId,
        namespaces: input.namespaces,
      },
      permission: KnowledgePermission.Read,
      target: {
        namespace: doc.namespace,
        securityLevel: doc.securityLevel,
        lifecycle: doc.lifecycle,
      },
    });

    if (!decision.allowed) {
      filteredCount++;
      continue;
    }

    // Deduplication by content hash
    if (seenContentHashes.has(doc.contentHash)) {
      filteredCount++;
      continue;
    }
    seenContentHashes.add(doc.contentHash);

    // Truncate content to snippet length
    const content =
      doc.content.length > snippetLength
        ? doc.content.slice(0, snippetLength) + '...'
        : doc.content;

    allItems.push({
      id: doc.id,
      source: 'knowledge',
      section: 'knowledge',
      content: `[${doc.title}] ${content}`,
      priority: doc.securityLevel === 'CONFIDENTIAL' ? 'high' : 'normal',
      metadata: {
        namespace: doc.namespace,
        version: doc.version,
        contentType: doc.contentType,
        sourceType: doc.source.sourceType,
        createdAt: doc.createdAt,
      } satisfies Record<string, string | number | boolean>,
      order: allItems.length,
    });
  }

  // Apply budget constraint
  const selected: KnowledgeContextItem[] = [];
  let tokenEstimate = 0;

  for (const item of allItems) {
    if (selected.length >= maxResults) break;
    const itemTokens = estimateTokens(item.content);
    if (tokenEstimate + itemTokens > contextBudgetTokens) break;
    selected.push(item);
    tokenEstimate += itemTokens;
  }

  return {
    items: selected,
    estimatedTokens: tokenEstimate,
    filteredCount,
    includedCount: selected.length,
  };
}
