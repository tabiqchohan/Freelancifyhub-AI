/**
 * Sprint 22 — Freelancer AI Team v1. Freelancer context builder.
 *
 * Assembles bounded, sanitized context from AG-002 memory and AG-003 knowledge
 * through their real, authorized contracts (MemoryManagerContract.retrieve +
 * KnowledgeManagerService.search) using the FREELANCER actor groups. Context
 * is always OPTIONAL for the deterministic agents and never fails the request
 * on retrieval errors; retrieval authorization failures degrade to empty +
 * warning, never leak.
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
import { FREELANCER_CONTEXT_LIMITS } from './constants.js';
import { sanitizeFreelancerText } from './security.js';
import type { FreelancerActor, FreelancerContext, FreelancerContextItem } from './types.js';

/** Dependencies for the context builder. */
export interface FreelancerContextBuilderOptions {
  readonly memory: MemoryManagerContract;
  readonly knowledge: KnowledgeManagerService;
  readonly limits?: {
    readonly maxMemoryItems?: number;
    readonly maxKnowledgeDocs?: number;
    readonly maxContextBytes?: number;
  };
  readonly logger?: Logger;
}

/** Single memory/keyword query seeded from the freelancer request. */
export interface FreelancerContextQuery {
  readonly brief: string;
  readonly keywords: readonly string[];
}

/**
 * Builds the bounded request context for freelancer agents. Memory + knowledge
 * retrieval go through the authorization scopes of the acting freelancer.
 */
export class FreelancerContextBuilder {
  readonly name = 'freelancer-context-builder';

  private readonly memory: MemoryManagerContract;
  private readonly knowledge: KnowledgeManagerService;
  private readonly limits: {
    readonly maxMemoryItems: number;
    readonly maxKnowledgeDocs: number;
    readonly maxContextBytes: number;
  };
  private readonly logger?: Logger;

  constructor(options: FreelancerContextBuilderOptions) {
    this.memory = options.memory;
    this.knowledge = options.knowledge;
    this.limits = {
      maxMemoryItems: options.limits?.maxMemoryItems ?? FREELANCER_CONTEXT_LIMITS.maxMemoryItems,
      maxKnowledgeDocs:
        options.limits?.maxKnowledgeDocs ?? FREELANCER_CONTEXT_LIMITS.maxKnowledgeDocs,
      maxContextBytes: options.limits?.maxContextBytes ?? FREELANCER_CONTEXT_LIMITS.maxContextBytes,
    };
    this.logger = options.logger;
  }

  /** Builds memory + knowledge context for the request (never throws). */
  async build(request: {
    readonly actor: FreelancerActor;
    readonly traceId?: string;
    readonly query: FreelancerContextQuery;
    readonly namespaces?: readonly string[];
  }): Promise<FreelancerContext> {
    const memory: FreelancerContextItem[] = [];
    const knowledge: FreelancerContextItem[] = [];
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
    readonly actor: FreelancerActor;
    readonly traceId?: string;
    readonly query: FreelancerContextQuery;
    readonly namespaces?: readonly string[];
  }): Promise<{
    readonly memoryItems: readonly FreelancerContextItem[];
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
      group: MemoryActorGroup.Freelancer,
      id: request.actor.actorId,
      role: request.actor.role,
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
      this.logger?.warn({ traceId: request.traceId }, 'freelancer memory retrieval degraded');
      void error;
      return {
        memoryItems: [],
        memoryWarnings: ['Memory retrieval temporarily unavailable; continuing with the request.'],
      };
    }
  }

  private async buildKnowledge(request: {
    readonly actor: FreelancerActor;
    readonly traceId?: string;
    readonly query: FreelancerContextQuery;
    readonly namespaces?: readonly string[];
  }): Promise<{
    readonly knowledgeDocs: readonly FreelancerContextItem[];
    readonly knowledgeWarnings: readonly string[];
  }> {
    const namespaces = request.namespaces ?? request.actor.namespaces;
    if (namespaces.length === 0) {
      return { knowledgeDocs: [], knowledgeWarnings: ['Knowledge search skipped: no namespaces.'] };
    }
    const query: KnowledgeSearchInput = {
      query: buildQueryText(request.query),
      namespace: namespaces[0]!,
      actorGroup: KnowledgeActorGroup.Freelancer,
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
        result = await this.knowledge.search({ ...query, query: 'freelancer profile' });
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
      this.logger?.warn({ traceId: request.traceId }, 'freelancer knowledge search degraded');
      void error;
      return {
        knowledgeDocs: [],
        knowledgeWarnings: [
          'Knowledge search temporarily unavailable; continuing with the request.',
        ],
      };
    }
  }
}

/** Bounds total context to `maxBytes`, keeping deterministic order. */
function boundContext(
  memory: readonly FreelancerContextItem[],
  knowledge: readonly FreelancerContextItem[],
  maxBytes: number,
): {
  readonly memory: readonly FreelancerContextItem[];
  readonly knowledge: readonly FreelancerContextItem[];
  readonly truncated: boolean;
} {
  const combined: Array<{
    readonly kind: 'memory' | 'knowledge';
    readonly item: FreelancerContextItem;
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

function sanitizeItem(item: FreelancerContextItem): FreelancerContextItem {
  const content = sanitizeFreelancerText(item.content, 4_096);
  return { ...item, content: content.length === 0 ? '[redacted item]' : content };
}

function redactedContent(content: MemoryJsonValue): string {
  const text = typeof content === 'string' ? content : safeSerialize(content);
  return sanitizeFreelancerText(text, 4_096);
}

function safeSerialize(value: MemoryJsonValue): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

function neutralizedContent(content: string): string {
  return sanitizeFreelancerText(content, 4_096);
}

function buildQueryText(query: FreelancerContextQuery): string {
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
