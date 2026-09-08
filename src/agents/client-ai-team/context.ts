/**
 * Sprint 21 — Client AI Team v1. Client context builder (§9).
 *
 * Assembles bounded, sanitized context from AG-002 memory and AG-003 knowledge
 * through their real, authorized contracts (MemoryManagerContract.retrieve +
 * KnowledgeManagerService.search). Context is always OPTIONAL for the
 * deterministic agents and never fails the request on retrieval errors;
 * retrieval authorization failures degrade to empty + warning, never leak.
 */

import type { Logger } from 'pino';

import type {
  MemoryActor,
  MemoryJsonValue,
  MemoryManagerContract,
} from '../ag-002-memory-manager/index.js';
import { MemoryActorGroup } from '../ag-002-memory-manager/index.js';
import type { MemorySecurityLevel } from '../ag-002-memory-manager/index.js';
import type {
  KnowledgeSearchInput,
  KnowledgeSearchResult,
} from '../ag-003-knowledge-manager/index.js';
import { KnowledgeActorGroup } from '../ag-003-knowledge-manager/index.js';
import type { KnowledgeManagerService } from '../ag-003-knowledge-manager/index.js';
import { CLIENT_CONTEXT_LIMITS } from './constants.js';
import { sanitizeClientText } from './security.js';
import type { ClientActor, ClientContext, ClientContextItem } from './types.js';

/** Dependencies for the context builder. */
export interface ClientContextBuilderOptions {
  readonly memory: MemoryManagerContract;
  readonly knowledge: KnowledgeManagerService;
  readonly limits?: {
    readonly maxMemoryItems?: number;
    readonly maxKnowledgeDocs?: number;
    readonly maxContextBytes?: number;
  };
  readonly logger?: Logger;
}

/** Single memory/keyword query seeded from the client request. */
export interface ClientContextQuery {
  readonly brief: string;
  readonly keywords: readonly string[];
}

/**
 * Builds the bounded request context for client agents. Memory + knowledge
 * retrieval go through the authorization scopes of the acting client.
 */
export class ClientContextBuilder {
  readonly name = 'client-context-builder';

  private readonly memory: MemoryManagerContract;
  private readonly knowledge: KnowledgeManagerService;
  private readonly limits: {
    readonly maxMemoryItems: number;
    readonly maxKnowledgeDocs: number;
    readonly maxContextBytes: number;
  };
  private readonly logger?: Logger;

  constructor(options: ClientContextBuilderOptions) {
    this.memory = options.memory;
    this.knowledge = options.knowledge;
    this.limits = {
      maxMemoryItems: options.limits?.maxMemoryItems ?? CLIENT_CONTEXT_LIMITS.maxMemoryItems,
      maxKnowledgeDocs: options.limits?.maxKnowledgeDocs ?? CLIENT_CONTEXT_LIMITS.maxKnowledgeDocs,
      maxContextBytes: options.limits?.maxContextBytes ?? CLIENT_CONTEXT_LIMITS.maxContextBytes,
    };
    this.logger = options.logger;
  }

  /** Builds memory + knowledge context for the request (never throws). */
  async build(request: {
    readonly actor: ClientActor;
    readonly traceId?: string;
    readonly query: ClientContextQuery;
    readonly namespaces?: readonly string[];
  }): Promise<ClientContext> {
    const memory: ClientContextItem[] = [];
    const knowledge: ClientContextItem[] = [];
    const warnings: string[] = [];

    const { memoryItems, memoryWarnings } = await this.buildMemory(request);
    memory.push(...memoryItems);
    warnings.push(...memoryWarnings);

    const { knowledgeDocs, knowledgeWarnings } = await this.buildKnowledge(request);
    knowledge.push(...knowledgeDocs);
    warnings.push(...knowledgeWarnings);

    const bounded = boundContext(memory, knowledge, this.limits.maxContextBytes);
    return {
      memory: bounded.memory.map(sanitizeItem),
      knowledge: bounded.knowledge.map(sanitizeItem),
      truncated: bounded.truncated,
      warnings,
    };
  }

  private async buildMemory(request: {
    readonly actor: ClientActor;
    readonly traceId?: string;
    readonly query: ClientContextQuery;
    readonly namespaces?: readonly string[];
  }): Promise<{
    readonly memoryItems: readonly ClientContextItem[];
    readonly memoryWarnings: readonly string[];
  }> {
    const namespaces = request.namespaces ?? request.actor.namespaces;
    if (
      namespaces.length === 0 ||
      !namespaces.some((namespace) => request.actor.namespaces.includes(namespace))
    ) {
      return {
        memoryItems: [],
        memoryWarnings: ['Memory retrieval skipped: actor has no authorized namespace.'],
      };
    }
    const primaryNamespace = namespaces.find((namespace) =>
      request.actor.namespaces.includes(namespace),
    );
    if (primaryNamespace === undefined) {
      return {
        memoryItems: [],
        memoryWarnings: ['Memory retrieval skipped: no authorized primary namespace.'],
      };
    }
    const actor: MemoryActor = {
      group: MemoryActorGroup.Client,
      id: request.actor.actorId,
      role: request.actor.role,
      organizationId: request.actor.organizationId,
      workspaceId: request.actor.workspaceId,
      projectIds: request.actor.projectIds,
      securityClearance: request.actor.securityClearance as MemorySecurityLevel | undefined,
      namespaces: request.actor.namespaces,
    };
    try {
      const queryText = buildQueryText(request.query);
      const results = await this.memory.retrieve({
        actor,
        namespace: primaryNamespace,
        query: queryText.length > 0 ? queryText : undefined,
        limit: this.limits.maxMemoryItems,
        traceId: request.traceId,
      });
      const items = results.slice(0, this.limits.maxMemoryItems).map((result) => ({
        id: String(result.record.id),
        namespace: result.record.namespace,
        key: result.record.key,
        content: redactedContent(result.record.content),
        source: 'memory',
      }));
      return { memoryItems: items, memoryWarnings: [] };
    } catch (error) {
      this.logger?.warn({ traceId: request.traceId }, 'client memory retrieval degraded');
      void error;
      return {
        memoryItems: [],
        memoryWarnings: ['Memory retrieval temporarily unavailable; continuing with the brief.'],
      };
    }
  }

  private async buildKnowledge(request: {
    readonly actor: ClientActor;
    readonly traceId?: string;
    readonly query: ClientContextQuery;
    readonly namespaces?: readonly string[];
  }): Promise<{
    readonly knowledgeDocs: readonly ClientContextItem[];
    readonly knowledgeWarnings: readonly string[];
  }> {
    const namespaces = request.namespaces ?? request.actor.namespaces;
    if (namespaces.length === 0) {
      return { knowledgeDocs: [], knowledgeWarnings: ['Knowledge search skipped: no namespaces.'] };
    }
    const query: KnowledgeSearchInput = {
      query: buildQueryText(request.query),
      namespace: namespaces[0]!,
      actorGroup: KnowledgeActorGroup.Client,
      actorId: request.actor.actorId,
      maxResults: this.limits.maxKnowledgeDocs,
      namespaces,
    };
    try {
      let result: KnowledgeSearchResult;
      try {
        result = await this.knowledge.search(query);
      } catch {
        // Known query text may be empty for intent-only requests; retry once
        // with a neutral keyword rather than failing the request.
        result = await this.knowledge.search({ ...query, query: 'project brief' });
      }
      const docs = result.documents.slice(0, this.limits.maxKnowledgeDocs).map((doc) => ({
        id: doc.id,
        namespace: doc.namespace,
        key: doc.title,
        content: neutralizedContent(doc.content),
        source: 'knowledge',
      }));
      return { knowledgeDocs: docs, knowledgeWarnings: [] };
    } catch (error) {
      this.logger?.warn({ traceId: request.traceId }, 'client knowledge search degraded');
      void error;
      return {
        knowledgeDocs: [],
        knowledgeWarnings: ['Knowledge search temporarily unavailable; continuing with the brief.'],
      };
    }
  }
}

/** Bounds total context to `maxBytes`, keeping deterministic order. */
function boundContext(
  memory: readonly ClientContextItem[],
  knowledge: readonly ClientContextItem[],
  maxBytes: number,
): {
  readonly memory: readonly ClientContextItem[];
  readonly knowledge: readonly ClientContextItem[];
  readonly truncated: boolean;
} {
  const combined: Array<{
    readonly kind: 'memory' | 'knowledge';
    readonly item: ClientContextItem;
  }> = [
    ...memory.map((item) => ({ kind: 'memory' as const, item })),
    ...knowledge.map((item) => ({ kind: 'knowledge' as const, item })),
  ];
  const kept: typeof combined = [];
  let used = 0;
  let truncated = false;
  for (const entry of combined) {
    const size = byteLength(entry.item.content);
    if (used + size > maxBytes) {
      truncated = true;
      continue;
    }
    kept.push(entry);
    used += size;
  }
  return {
    memory: kept.filter((entry) => entry.kind === 'memory').map((entry) => entry.item),
    knowledge: kept.filter((entry) => entry.kind === 'knowledge').map((entry) => entry.item),
    truncated,
  };
}

function sanitizeItem(item: ClientContextItem): ClientContextItem {
  const content = sanitizeClientText(item.content, 4_096);
  return { ...item, content: content.length === 0 ? '[redacted item]' : content };
}

function redactedContent(content: MemoryJsonValue): string {
  const text = typeof content === 'string' ? content : safeSerialize(content);
  return sanitizeClientText(text, 4_096);
}

function safeSerialize(value: MemoryJsonValue): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

function neutralizedContent(content: string): string {
  return sanitizeClientText(content, 4_096);
}

function buildQueryText(query: ClientContextQuery): string {
  const keywords = (query.keywords ?? []).filter((keyword) => keyword.trim().length > 0);
  if (query.brief.trim().length > 0) {
    const briefWords = query.brief.split(/\s+/).filter(Boolean);
    return briefWords.slice(0, 16).join(' ');
  }
  if (keywords.length > 0) {
    return keywords.slice(0, 8).join(' ');
  }
  return '';
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}
