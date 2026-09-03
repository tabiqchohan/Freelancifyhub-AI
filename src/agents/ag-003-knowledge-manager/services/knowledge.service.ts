import type { Logger } from 'pino';

import type {
  KnowledgeChunk,
  KnowledgeDocument,
  KnowledgeDocumentFilter,
  KnowledgeDocumentPage,
  KnowledgeId,
  KnowledgeMetadata,
  KnowledgeNamespace,
  KnowledgePagination,
  KnowledgeSourceMetadata,
  KnowledgeVersion,
  TraceId,
} from '../types/index.js';
import type {
  KnowledgeActorGroup,
  KnowledgeContentType,
  KnowledgeLifecycleState,
  KnowledgeSecurityLevel,
} from '../enums/index.js';
import { KnowledgeLifecycleState as KnowledgeLifecycleStateValue } from '../enums/index.js';
import { createKnowledgeId, createTraceId, nowIso } from '../utils/ids.js';
import { normalizeKnowledgeInput } from '../normalization/index.js';
import { chunkDocument } from '../chunking/index.js';
import { createInitialVersion, createNewVersion } from '../versioning/index.js';
import { transitionKnowledgeDocument } from '../lifecycle/index.js';
import {
  type KnowledgeActor,
  type KnowledgeAuthorizationService,
  DefaultKnowledgeAuthorizationService,
} from '../security/index.js';
import { KnowledgePermission } from '../enums/index.js';
import type { KnowledgeEventLog } from '../events/index.js';
import { KnowledgeAuditEventType } from '../events/index.js';
import type { KnowledgeEvent } from '../events/index.js';
import type { KnowledgeConfig } from '../config/schema.js';
import {
  KnowledgeValidationError,
  KnowledgeNotFoundError,
  KnowledgeAccessDeniedError,
  KnowledgeLifecycleTransitionError,
  KnowledgeVersionError,
} from '../errors/index.js';
import {
  assertContentWithinLimits,
  assertMetadataWithinLimits,
  sizeLimitsFromConfig,
} from '../validators/index.js';

/** Repository interface for the knowledge service. */
export interface KnowledgeRepository {
  readonly name: string;
  create(document: KnowledgeDocument): Promise<KnowledgeDocument>;
  getById(id: string): Promise<KnowledgeDocument | undefined>;
  getCurrentVersion(documentId: string): Promise<KnowledgeVersion | undefined>;
  getVersion(documentId: string, versionNumber: number): Promise<KnowledgeVersion | undefined>;
  createVersion(version: KnowledgeVersion): Promise<KnowledgeVersion>;
  listVersions(documentId: string): Promise<readonly KnowledgeVersion[]>;
  updateDocument(document: KnowledgeDocument): Promise<KnowledgeDocument>;
  list(
    filter: KnowledgeDocumentFilter,
    pagination: KnowledgePagination,
  ): Promise<KnowledgeDocumentPage>;
  deleteDocument(id: string): Promise<boolean>;
  createChunks(chunks: readonly KnowledgeChunk[]): Promise<void>;
  getChunksByVersionId(versionId: string): Promise<readonly KnowledgeChunk[]>;
  getChunksByDocumentId(documentId: string): Promise<readonly KnowledgeChunk[]>;
  healthAsync(): Promise<{ healthy: boolean; message: string }>;
  eraseByNamespace(namespace: string): Promise<number>;
}

/** Dependencies for the knowledge service. */
export interface KnowledgeServiceDependencies {
  readonly repository: KnowledgeRepository;
  readonly authorizationService?: KnowledgeAuthorizationService;
  readonly eventLog?: KnowledgeEventLog;
  readonly config: KnowledgeConfig;
  readonly logger?: Logger;
}

/** Input for creating a knowledge document. */
export interface CreateKnowledgeInput {
  readonly title: string;
  readonly content: string;
  readonly contentType: KnowledgeContentType;
  readonly namespace: KnowledgeNamespace;
  readonly securityLevel: KnowledgeSecurityLevel;
  readonly source: KnowledgeSourceMetadata;
  readonly metadata?: KnowledgeMetadata;
  readonly actorGroup: KnowledgeActorGroup;
  readonly actorId?: string;
  readonly traceId?: TraceId;
}

/** Input for creating a new version. */
export interface CreateKnowledgeVersionInput {
  readonly documentId: KnowledgeId;
  readonly title: string;
  readonly content: string;
  readonly contentType: KnowledgeContentType;
  readonly securityLevel: KnowledgeSecurityLevel;
  readonly source: KnowledgeSourceMetadata;
  readonly metadata?: KnowledgeMetadata;
  readonly actorGroup: KnowledgeActorGroup;
  readonly actorId?: string;
  readonly traceId?: TraceId;
}

/** Input for lifecycle transitions. */
export interface KnowledgeLifecycleInput {
  readonly documentId: KnowledgeId;
  readonly targetState: KnowledgeLifecycleState;
  readonly actorGroup: KnowledgeActorGroup;
  readonly actorId?: string;
  readonly reason?: string;
  readonly traceId?: TraceId;
}

/** Input for retrieval queries. */
export interface KnowledgeSearchInput {
  readonly query: string;
  readonly namespace: KnowledgeNamespace;
  readonly actorGroup: KnowledgeActorGroup;
  readonly actorId?: string;
  readonly maxResults?: number;
  readonly namespaces?: readonly KnowledgeNamespace[];
}

/** Result of a search operation. */
export interface KnowledgeSearchResult {
  readonly documents: readonly KnowledgeDocument[];
  readonly total: number;
}

/**
 * The main Knowledge Manager service. Orchestrates CRUD, versioning, lifecycle,
 * authorization, chunking, retrieval, and event emission.
 */
export class KnowledgeManagerService {
  private readonly repository: KnowledgeRepository;
  private readonly authorizationService: KnowledgeAuthorizationService;
  private readonly eventLog: KnowledgeEventLog | undefined;
  private readonly config: KnowledgeConfig;
  private readonly logger: Logger | undefined;

  constructor(dependencies: KnowledgeServiceDependencies) {
    this.repository = dependencies.repository;
    this.authorizationService =
      dependencies.authorizationService ?? new DefaultKnowledgeAuthorizationService();
    this.eventLog = dependencies.eventLog;
    this.config = dependencies.config;
    this.logger = dependencies.logger;
  }

  /** Create a new knowledge document. */
  async createDocument(input: CreateKnowledgeInput): Promise<KnowledgeDocument> {
    const traceId = input.traceId ?? createTraceId();
    const limits = sizeLimitsFromConfig(this.config);

    assertContentWithinLimits(input.content, limits);
    if (input.metadata !== undefined) {
      assertMetadataWithinLimits(input.metadata as Record<string, unknown>, limits);
    }

    const normalized = normalizeKnowledgeInput({
      title: input.title,
      content: input.content,
      namespace: input.namespace,
      contentType: input.contentType,
      securityLevel: input.securityLevel,
      source: input.source,
      metadata: input.metadata,
    });

    if (normalized.title.length > limits.maxTitleLength) {
      throw new KnowledgeValidationError('Title exceeds max length', {
        code: 'TITLE_TOO_LONG',
        details: { length: normalized.title.length, max: limits.maxTitleLength },
      });
    }

    const actor: KnowledgeActor = {
      group: input.actorGroup,
      id: input.actorId,
      namespaces: [input.namespace],
    };

    this.assertAuthorized(actor, KnowledgePermission.Create, {
      namespace: input.namespace,
      securityLevel: input.securityLevel,
      lifecycle: KnowledgeLifecycleStateValue.Active,
    });

    const at = nowIso();
    const document: KnowledgeDocument = {
      id: createKnowledgeId(),
      namespace: normalized.namespace,
      title: normalized.title,
      content: normalized.content,
      contentType: normalized.contentType,
      source: normalized.source,
      metadata: normalized.metadata,
      lifecycle: KnowledgeLifecycleStateValue.Active,
      securityLevel: normalized.securityLevel,
      version: 1,
      contentHash: normalized.contentHash,
      createdAt: at,
      updatedAt: at,
      createdBy: input.actorId ?? 'system',
      updatedBy: input.actorId ?? 'system',
      traceId,
    };

    const created = await this.repository.create(document);

    // Create initial version
    const version = createInitialVersion(created, input.actorId ?? 'system');
    await this.repository.createVersion(version);

    // Create chunks
    const chunks = chunkDocument({
      documentId: created.id,
      versionId: version.id,
      versionNumber: 1,
      content: created.content,
      metadata: created.metadata,
      createdAt: at,
      config: {
        maxChunkSize: this.config.KNOWLEDGE_CHUNK_MAX_SIZE,
        overlapSize: this.config.KNOWLEDGE_CHUNK_OVERLAP_SIZE,
      },
    });
    await this.repository.createChunks(chunks);

    // Emit event
    this.emitEvent({
      type: KnowledgeAuditEventType.Created,
      traceId,
      occurredAt: at,
      namespace: created.namespace,
      knowledgeId: created.id,
      versionId: version.id,
      actorGroup: input.actorGroup,
      actorId: input.actorId,
      versionNumber: 1,
      count: chunks.length,
      source: 'knowledge',
      service: 'knowledge-manager',
    });

    this.logger?.info(
      { documentId: created.id, namespace: created.namespace },
      'knowledge document created',
    );
    return created;
  }

  /** Get a document by ID (with authorization). */
  async getDocument(
    id: KnowledgeId,
    actorGroup: KnowledgeActorGroup,
    actorId?: string,
  ): Promise<KnowledgeDocument | undefined> {
    const doc = await this.repository.getById(id);
    if (doc === undefined) return undefined;

    const actor: KnowledgeActor = {
      group: actorGroup,
      id: actorId,
      namespaces: [doc.namespace],
    };

    const decision = this.authorizationService.authorize({
      actor,
      permission: KnowledgePermission.Read,
      target: {
        namespace: doc.namespace,
        securityLevel: doc.securityLevel,
        lifecycle: doc.lifecycle,
      },
    });

    if (!decision.allowed) {
      throw new KnowledgeAccessDeniedError(
        decision.reason ?? 'Not authorized to read this knowledge',
        { code: decision.code },
      );
    }

    return doc;
  }

  /** Create a new version of a document. */
  async createVersion(
    input: CreateKnowledgeVersionInput,
  ): Promise<{ document: KnowledgeDocument; version: KnowledgeVersion }> {
    const doc = await this.repository.getById(input.documentId);
    if (doc === undefined) {
      throw new KnowledgeNotFoundError(`Document ${input.documentId} not found`);
    }

    const actor: KnowledgeActor = {
      group: input.actorGroup,
      id: input.actorId,
      namespaces: [doc.namespace],
    };

    this.assertAuthorized(actor, KnowledgePermission.UpdateVersion, {
      namespace: doc.namespace,
      securityLevel: doc.securityLevel,
      lifecycle: doc.lifecycle,
    });

    const currentVersion = await this.repository.getCurrentVersion(input.documentId);
    if (currentVersion === undefined) {
      throw new KnowledgeVersionError('No current version found for document');
    }

    const traceId = input.traceId ?? createTraceId();
    const at = nowIso();
    const limits = sizeLimitsFromConfig(this.config);

    assertContentWithinLimits(input.content, limits);

    const normalized = normalizeKnowledgeInput({
      title: input.title,
      content: input.content,
      namespace: doc.namespace,
      contentType: input.contentType,
      securityLevel: input.securityLevel,
      source: input.source,
      metadata: input.metadata,
    });

    // Create the new version (immutable)
    const newVersion = createNewVersion(
      doc.id,
      currentVersion,
      normalized.content,
      normalized.title,
      normalized.metadata,
      normalized.contentType,
      normalized.securityLevel,
      normalized.source,
      input.actorId ?? 'system',
      at,
      traceId,
    );
    await this.repository.createVersion(newVersion);

    // Update document to reference new version
    const updatedDoc: KnowledgeDocument = {
      ...doc,
      title: normalized.title,
      content: normalized.content,
      contentType: normalized.contentType,
      source: normalized.source,
      metadata: normalized.metadata,
      securityLevel: normalized.securityLevel,
      version: newVersion.versionNumber,
      contentHash: normalized.contentHash,
      updatedAt: at,
      updatedBy: input.actorId ?? 'system',
      traceId,
    };
    await this.repository.updateDocument(updatedDoc);

    // Create chunks for the new version
    const chunks = chunkDocument({
      documentId: doc.id,
      versionId: newVersion.id,
      versionNumber: newVersion.versionNumber,
      content: normalized.content,
      metadata: normalized.metadata,
      createdAt: at,
      config: {
        maxChunkSize: this.config.KNOWLEDGE_CHUNK_MAX_SIZE,
        overlapSize: this.config.KNOWLEDGE_CHUNK_OVERLAP_SIZE,
      },
    });
    await this.repository.createChunks(chunks);

    // Emit event
    this.emitEvent({
      type: KnowledgeAuditEventType.VersionCreated,
      traceId,
      occurredAt: at,
      namespace: doc.namespace,
      knowledgeId: doc.id,
      versionId: newVersion.id,
      actorGroup: input.actorGroup,
      actorId: input.actorId,
      versionNumber: newVersion.versionNumber,
      previousVersionNumber: currentVersion.versionNumber,
      count: chunks.length,
      source: 'knowledge',
      service: 'knowledge-manager',
    });

    return { document: updatedDoc, version: newVersion };
  }

  /** Get all versions for a document. */
  async listVersions(documentId: KnowledgeId): Promise<readonly KnowledgeVersion[]> {
    return this.repository.listVersions(documentId);
  }

  /** Get a specific version. */
  async getVersion(
    documentId: KnowledgeId,
    versionNumber: number,
  ): Promise<KnowledgeVersion | undefined> {
    return this.repository.getVersion(documentId, versionNumber);
  }

  /** Apply a lifecycle transition. */
  async transitionLifecycle(input: KnowledgeLifecycleInput): Promise<KnowledgeDocument> {
    const doc = await this.repository.getById(input.documentId);
    if (doc === undefined) {
      throw new KnowledgeNotFoundError(`Document ${input.documentId} not found`);
    }

    const actor: KnowledgeActor = {
      group: input.actorGroup,
      id: input.actorId,
      namespaces: [doc.namespace],
    };

    const perm =
      input.targetState === KnowledgeLifecycleStateValue.Archived
        ? KnowledgePermission.Archive
        : input.targetState === KnowledgeLifecycleStateValue.Active
          ? KnowledgePermission.Restore
          : input.targetState === KnowledgeLifecycleStateValue.Expired
            ? KnowledgePermission.Expire
            : KnowledgePermission.DeleteErase;

    this.assertAuthorized(actor, perm, {
      namespace: doc.namespace,
      securityLevel: doc.securityLevel,
      lifecycle: doc.lifecycle,
    });

    const traceId = input.traceId ?? createTraceId();
    const at = nowIso();

    try {
      const result = transitionKnowledgeDocument(
        doc,
        input.targetState,
        at,
        traceId,
        input.reason ?? `transition to ${input.targetState}`,
      );

      const updated = await this.repository.updateDocument(result.document);

      const eventType =
        input.targetState === KnowledgeLifecycleStateValue.Archived
          ? KnowledgeAuditEventType.Archived
          : input.targetState === KnowledgeLifecycleStateValue.Active
            ? KnowledgeAuditEventType.Restored
            : input.targetState === KnowledgeLifecycleStateValue.Expired
              ? KnowledgeAuditEventType.Expired
              : KnowledgeAuditEventType.Deleted;

      this.emitEvent({
        type: eventType,
        traceId,
        occurredAt: at,
        namespace: doc.namespace,
        knowledgeId: doc.id,
        actorGroup: input.actorGroup,
        actorId: input.actorId,
        versionNumber: doc.version,
        reason: input.reason,
        source: 'lifecycle',
        service: 'knowledge-manager',
      });

      return updated;
    } catch (err) {
      if (err instanceof KnowledgeLifecycleTransitionError) {
        throw err;
      }
      throw err;
    }
  }

  /** Search knowledge documents with retrieval scoring. */
  async search(input: KnowledgeSearchInput): Promise<KnowledgeSearchResult> {
    const namespaces = input.namespaces ?? [input.namespace];

    // Collect all documents across allowed namespaces
    const allDocs: KnowledgeDocument[] = [];
    for (const ns of namespaces) {
      const page = await this.repository.list(
        { namespace: ns, lifecycle: KnowledgeLifecycleStateValue.Active },
        { offset: 0, limit: 100 },
      );
      allDocs.push(...page.items);
    }

    // Authorization filter: only return docs the actor can read
    const authorizedDocs: KnowledgeDocument[] = [];
    for (const doc of allDocs) {
      const actor: KnowledgeActor = {
        group: input.actorGroup,
        id: input.actorId,
        namespaces,
      };
      const decision = this.authorizationService.authorize({
        actor,
        permission: KnowledgePermission.Read,
        target: {
          namespace: doc.namespace,
          securityLevel: doc.securityLevel,
          lifecycle: doc.lifecycle,
        },
      });
      if (decision.allowed) {
        authorizedDocs.push(doc);
      }
    }

    // Simple scoring for now
    const scored = authorizedDocs
      .map((doc) => {
        const query = input.query.toLowerCase();
        let score = 0;
        if (doc.title.toLowerCase().includes(query)) score += 30;
        if (doc.content.toLowerCase().includes(query)) score += 20;
        return { doc, score };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || a.doc.title.localeCompare(b.doc.title));

    const maxResults = input.maxResults ?? this.config.KNOWLEDGE_RETRIEVAL_MAX_RESULTS;
    const results = scored.slice(0, maxResults).map((s) => s.doc);

    // Emit retrieval event
    const traceId = createTraceId();
    this.emitEvent({
      type: KnowledgeAuditEventType.Retrieved,
      traceId,
      occurredAt: nowIso(),
      namespace: input.namespace,
      actorGroup: input.actorGroup,
      actorId: input.actorId,
      count: results.length,
      source: 'retrieval',
      service: 'knowledge-manager',
    });

    return { documents: results, total: results.length };
  }

  /** List documents with filtering and pagination. */
  async listDocuments(
    filter: KnowledgeDocumentFilter,
    pagination: KnowledgePagination,
  ): Promise<KnowledgeDocumentPage> {
    return this.repository.list(filter, pagination);
  }

  /** Delete a document. */
  async deleteDocument(id: KnowledgeId): Promise<boolean> {
    return this.repository.deleteDocument(id);
  }

  /** Health check. */
  async healthAsync(): Promise<{ healthy: boolean; message: string }> {
    return this.repository.healthAsync();
  }

  /** Erase all knowledge in a namespace. */
  async eraseByNamespace(namespace: string): Promise<number> {
    return this.repository.eraseByNamespace(namespace);
  }

  /** Internal authorization assertion (fail-closed). */
  private assertAuthorized(
    actor: KnowledgeActor,
    permission: KnowledgePermission,
    target: { namespace: string; securityLevel: string; lifecycle: string },
  ): void {
    const decision = this.authorizationService.authorize({
      actor,
      permission,
      target: {
        namespace: target.namespace as KnowledgeNamespace,
        securityLevel: target.securityLevel as KnowledgeSecurityLevel,
        lifecycle: target.lifecycle as KnowledgeLifecycleState,
      },
    });

    if (!decision.allowed) {
      throw new KnowledgeAccessDeniedError(decision.reason ?? 'Not authorized', {
        code: decision.code,
      });
    }
  }

  private emitEvent(event: KnowledgeEvent): void {
    if (this.eventLog === undefined) return;
    try {
      this.eventLog.append(event);
    } catch (err) {
      this.logger?.warn({ error: err }, 'failed to emit knowledge event');
    }
  }
}

/** Creates a KnowledgeManagerService with all dependencies. */
export function createKnowledgeManagerService(
  dependencies: KnowledgeServiceDependencies,
): KnowledgeManagerService {
  return new KnowledgeManagerService(dependencies);
}
