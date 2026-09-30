import type { Logger } from 'pino';

import type {
  KnowledgeChunk,
  KnowledgeDocument,
  KnowledgeDocumentFilter,
  KnowledgeDocumentPage,
  KnowledgeId,
  KnowledgeMetadata,
  KnowledgeNamespace,
  KnowledgeNamespaceRecord,
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
import { KnowledgeSecurityLevel as KnowledgeSecurityLevelValue } from '../enums/index.js';
import { createKnowledgeId, createTraceId, nowIso } from '../utils/ids.js';
import { normalizeKnowledgeInput } from '../normalization/index.js';
import { chunkDocument } from '../chunking/index.js';
import { createInitialVersion, createNewVersion } from '../versioning/index.js';
import { transitionKnowledgeDocument } from '../lifecycle/index.js';
import {
  type KnowledgeActor,
  type KnowledgeAuthorizationService,
  DefaultKnowledgeAuthorizationService,
  knowledgeGroupHasPermission,
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
  assertKnowledgeIdentifier,
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
  /**
   * Sprint 35 F-1 — reads the persisted namespace authorization record.
   * Returns `undefined` when the namespace has never been claimed.
   */
  getNamespaceRecord(namespace: string): Promise<KnowledgeNamespaceRecord | undefined>;
  /**
   * Sprint 35 F-1 — atomically claims ownership of an unclaimed namespace.
   *
   * Returns the persisted record. When the namespace is already claimed by a
   * *different* actor the claim is refused (`claimed: false`) so a concurrent
   * or forged self-grant can never take over an existing namespace. Re-claiming
   * by the existing owner is idempotent.
   */
  claimNamespace(
    namespace: string,
    actorId: string,
    at: string,
  ): Promise<{ claimed: boolean; record: KnowledgeNamespaceRecord }>;
  /**
   * Sprint 35 F-1 — grants an additional member to an existing namespace.
   * Returns `false` when the namespace does not exist (fail-closed) so a caller
   * cannot materialize a namespace as a side effect of adding a member.
   */
  addNamespaceMember(namespace: string, actorId: string, at: string): Promise<boolean>;
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
  /**
   * Sprint 35 F-1 — required. The actor id is the key that persisted namespace
   * ownership/membership is resolved against, so an operation whose actor
   * cannot be established is denied rather than attributed to a default.
   */
  readonly actorId: string;
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
  /** Sprint 35 F-1 — required; see {@link CreateKnowledgeInput.actorId}. */
  readonly actorId: string;
  readonly traceId?: TraceId;
}

/** Input for lifecycle transitions. */
export interface KnowledgeLifecycleInput {
  readonly documentId: KnowledgeId;
  readonly targetState: KnowledgeLifecycleState;
  readonly actorGroup: KnowledgeActorGroup;
  /** Sprint 35 F-1 — required; see {@link CreateKnowledgeInput.actorId}. */
  readonly actorId: string;
  readonly reason?: string;
  readonly traceId?: TraceId;
}

/** Input for retrieval queries. */
export interface KnowledgeSearchInput {
  readonly query: string;
  readonly namespace: KnowledgeNamespace;
  readonly actorGroup: KnowledgeActorGroup;
  /** Sprint 35 F-1 — required; see {@link CreateKnowledgeInput.actorId}. */
  readonly actorId: string;
  readonly maxResults?: number;
  readonly namespaces?: readonly KnowledgeNamespace[];
}

/** Result of a search operation. */
export interface KnowledgeSearchResult {
  readonly documents: readonly KnowledgeDocument[];
  readonly total: number;
}

/**
 * Sprint 35 (Phase 14) — hard ceiling on how many namespaces a single search may
 * span, so a caller cannot force unbounded per-namespace repository work.
 */
const MAX_SEARCH_NAMESPACES = 32;

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

    const actor: KnowledgeActor = await this.claimAndScope(
      input.actorGroup,
      input.actorId,
      input.namespace,
      nowIso(),
    );

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
      // Sprint 35 F-1 — attributed to the established actor, never a default.
      createdBy: input.actorId,
      updatedBy: input.actorId,
      traceId,
    };

    const created = await this.repository.create(document);

    // Create initial version
    const version = createInitialVersion(created, input.actorId);
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
    actorId: string,
  ): Promise<KnowledgeDocument | undefined> {
    assertKnowledgeIdentifier(id, 'documentId');
    const doc = await this.repository.getById(id);
    if (doc === undefined) return undefined;

    // Sprint 35 F-1 — scope comes from persisted namespace membership, not from
    // the document being fetched. Fetching a document by (guessed) id therefore
    // no longer confers access to its namespace.
    const actor: KnowledgeActor = await this.resolveScopedActor(actorGroup, actorId, doc.namespace);

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
    assertKnowledgeIdentifier(input.documentId, 'documentId');
    const doc = await this.repository.getById(input.documentId);
    if (doc === undefined) {
      throw new KnowledgeNotFoundError(`Document ${input.documentId} not found`);
    }

    // Sprint 35 F-1 — persisted namespace scope + ownership enforcement.
    const actor: KnowledgeActor = await this.resolveScopedActor(
      input.actorGroup,
      input.actorId,
      doc.namespace,
    );

    this.assertAuthorized(actor, KnowledgePermission.UpdateVersion, {
      namespace: doc.namespace,
      securityLevel: doc.securityLevel,
      lifecycle: doc.lifecycle,
      createdBy: doc.createdBy,
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
      input.actorId,
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
      updatedBy: input.actorId,
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

  /**
   * Get all versions for a document.
   *
   * Sprint 35 F-1 — version history is knowledge content, so it is authorized
   * against the same persisted namespace scope as the document itself.
   */
  async listVersions(
    documentId: KnowledgeId,
    actorGroup: KnowledgeActorGroup,
    actorId: string,
  ): Promise<readonly KnowledgeVersion[]> {
    await this.assertDocumentReadable(documentId, actorGroup, actorId);
    return this.repository.listVersions(documentId);
  }

  /** Get a specific version. Sprint 35 F-1 — authorized like the document. */
  async getVersion(
    documentId: KnowledgeId,
    versionNumber: number,
    actorGroup: KnowledgeActorGroup,
    actorId: string,
  ): Promise<KnowledgeVersion | undefined> {
    await this.assertDocumentReadable(documentId, actorGroup, actorId);
    return this.repository.getVersion(documentId, versionNumber);
  }

  /** Apply a lifecycle transition. */
  async transitionLifecycle(input: KnowledgeLifecycleInput): Promise<KnowledgeDocument> {
    assertKnowledgeIdentifier(input.documentId, 'documentId');
    const doc = await this.repository.getById(input.documentId);
    if (doc === undefined) {
      throw new KnowledgeNotFoundError(`Document ${input.documentId} not found`);
    }

    // Sprint 35 F-1 — persisted namespace scope + ownership enforcement.
    const actor: KnowledgeActor = await this.resolveScopedActor(
      input.actorGroup,
      input.actorId,
      doc.namespace,
    );

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
      createdBy: doc.createdBy,
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
    assertKnowledgeIdentifier(input.namespace, 'namespace');
    const requested = input.namespaces ?? [input.namespace];
    // Sprint 35 (Phase 14) — bound and validate every requested namespace so a
    // caller cannot submit an unbounded/garbage namespace list.
    const namespaces = requested.slice(0, MAX_SEARCH_NAMESPACES);
    for (const ns of namespaces) {
      assertKnowledgeIdentifier(ns, 'namespace');
    }

    // Collect all documents across the requested namespaces. Membership decides
    // visibility below; this only bounds the work.
    const allDocs: KnowledgeDocument[] = [];
    for (const ns of namespaces) {
      const page = await this.repository.list(
        { namespace: ns, lifecycle: KnowledgeLifecycleStateValue.Active },
        { offset: 0, limit: 100 },
      );
      allDocs.push(...page.items);
    }

    // Sprint 35 F-1 — authorization filter resolves each document's scope from
    // persisted namespace membership. Previously the actor was granted the whole
    // requested namespace list, so naming a namespace was enough to read it.
    const authorizedDocs: KnowledgeDocument[] = [];
    for (const doc of allDocs) {
      const actor: KnowledgeActor = await this.resolveScopedActor(
        input.actorGroup,
        input.actorId,
        doc.namespace,
      );
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

    // Sprint 33 — clamp caller-supplied limits so an unauthenticated caller
    // cannot force unbounded result assembly; the configured cap is the ceiling.
    // 0 is honored as an explicit "no results" request for consistency
    // with the memory retrieval contract.
    const configured = this.config.KNOWLEDGE_RETRIEVAL_MAX_RESULTS;
    const maxResults =
      input.maxResults !== undefined
        ? input.maxResults <= 0
          ? 0
          : Math.min(Math.floor(input.maxResults), configured)
        : configured;
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

  /**
   * List documents with filtering and pagination.
   *
   * Sprint 35 F-1 — listing is authorized against persisted namespace
   * membership. A filter naming namespaces the actor is not a member of yields
   * no rows for those namespaces (fail-closed) instead of their contents.
   */
  async listDocuments(
    filter: KnowledgeDocumentFilter,
    pagination: KnowledgePagination,
    actorGroup?: KnowledgeActorGroup,
    actorId?: string,
  ): Promise<KnowledgeDocumentPage> {
    if (actorGroup === undefined) {
      // Fail-closed: without a trusted actor no namespace can be authorized.
      return { items: [], total: 0, offset: 0, limit: 0, hasMore: false };
    }

    // Sprint 35 F-1 — every returned document is authorized on its *own*
    // security level and lifecycle. Namespace membership alone is not enough:
    // a member with Internal clearance must not receive Confidential rows, and
    // nothing in a `Deleted` state may ever be listed.
    const visibleIn = async (docs: readonly KnowledgeDocument[]): Promise<KnowledgeDocument[]> => {
      const visible: KnowledgeDocument[] = [];
      for (const doc of docs) {
        const actor = await this.resolveScopedActor(actorGroup, actorId, doc.namespace);
        const decision = this.authorizationService.authorize({
          actor,
          permission: KnowledgePermission.Read,
          target: {
            namespace: doc.namespace,
            securityLevel: doc.securityLevel,
            lifecycle: doc.lifecycle,
          },
        });
        if (decision.allowed) visible.push(doc);
      }
      return visible;
    };

    const page = await this.repository.list(filter, pagination);
    const items = await visibleIn(page.items);

    if (filter.namespace !== undefined) {
      // A namespace-filtered page is authorized per document, so the totals
      // describe only rows the actor may actually read.
      const scanned = items.length;
      return {
        items,
        total: scanned,
        offset: pagination.offset,
        limit: pagination.limit,
        hasMore: page.hasMore || scanned < page.items.length,
      };
    }

    // Sprint 35 F-1 — unscoped listing. Reporting the repository's `total` or
    // `hasMore` would disclose the number of documents in namespaces the actor
    // cannot read, so the count is recomputed from authorized rows only and is
    // deliberately an under-count when the scan was bounded.
    const bounded = items.length < page.items.length;
    return {
      items,
      total: items.length,
      offset: pagination.offset,
      limit: pagination.limit,
      hasMore: page.hasMore || bounded,
    };
  }

  /**
   * Delete a document.
   *
   * Sprint 35 F-1 — this was an unauthenticated delete of any document by id.
   * It is now authorized against persisted namespace membership and ownership.
   */
  async deleteDocument(
    id: KnowledgeId,
    actorGroup: KnowledgeActorGroup,
    actorId: string,
  ): Promise<boolean> {
    assertKnowledgeIdentifier(id, 'documentId');
    const doc = await this.repository.getById(id);
    if (doc === undefined) return false;

    const actor: KnowledgeActor = await this.resolveScopedActor(actorGroup, actorId, doc.namespace);
    this.assertAuthorized(actor, KnowledgePermission.DeleteErase, {
      namespace: doc.namespace,
      securityLevel: doc.securityLevel,
      lifecycle: doc.lifecycle,
      createdBy: doc.createdBy,
    });

    return this.repository.deleteDocument(id);
  }

  /** Health check. */
  async healthAsync(): Promise<{ healthy: boolean; message: string }> {
    return this.repository.healthAsync();
  }

  /**
   * Erase all knowledge in a namespace.
   *
   * Sprint 35 F-1 — destructive bulk operation, previously callable with no
   * authorization at all. Requires namespace membership plus the erase
   * capability.
   */
  async eraseByNamespace(
    namespace: string,
    actorGroup: KnowledgeActorGroup,
    actorId: string,
  ): Promise<number> {
    assertKnowledgeIdentifier(namespace, 'namespace');
    const actor = await this.resolveScopedActor(actorGroup, actorId, namespace);
    this.assertAuthorized(actor, KnowledgePermission.DeleteErase, {
      namespace,
      securityLevel: KnowledgeSecurityLevelValue.Internal,
      lifecycle: KnowledgeLifecycleStateValue.Active,
    });
    return this.repository.eraseByNamespace(namespace);
  }

  /** Internal authorization assertion (fail-closed). */
  private assertAuthorized(
    actor: KnowledgeActor,
    permission: KnowledgePermission,
    target: { namespace: string; securityLevel: string; lifecycle: string; createdBy?: string },
  ): void {
    const decision = this.authorizationService.authorize({
      actor,
      permission,
      target: {
        namespace: target.namespace as KnowledgeNamespace,
        securityLevel: target.securityLevel as KnowledgeSecurityLevel,
        lifecycle: target.lifecycle as KnowledgeLifecycleState,
        createdBy: target.createdBy,
      },
    });

    if (!decision.allowed) {
      throw new KnowledgeAccessDeniedError(decision.reason ?? 'Not authorized', {
        code: decision.code,
      });
    }
  }

  /**
   * Sprint 35 F-1 — asserts read access to a document via persisted namespace
   * scope. Shared by the version-history read paths.
   */
  private async assertDocumentReadable(
    documentId: KnowledgeId,
    actorGroup: KnowledgeActorGroup,
    actorId: string,
  ): Promise<KnowledgeDocument> {
    assertKnowledgeIdentifier(documentId, 'documentId');
    const doc = await this.repository.getById(documentId);
    if (doc === undefined) {
      throw new KnowledgeNotFoundError(`Document ${documentId} not found`);
    }
    const actor = await this.resolveScopedActor(actorGroup, actorId, doc.namespace);
    this.assertAuthorized(actor, KnowledgePermission.Read, {
      namespace: doc.namespace,
      securityLevel: doc.securityLevel,
      lifecycle: doc.lifecycle,
    });
    return doc;
  }

  /**
   * Sprint 35 F-1 — resolves an actor's namespace scope from *persisted*
   * authorization state instead of from the request being served.
   *
   * Before the fix this method's callers assigned `actor.namespaces` to the
   * namespace they were about to touch, which made
   * {@link KnowledgeNamespaceScopePolicy} self-satisfying: any caller could
   * reach any namespace (and any document by guessed id) simply by naming it.
   *
   * Now the scope is granted only when the caller is the persisted owner or an
   * explicit member of the namespace. Anything else resolves to an *empty*
   * scope, which the existing fail-closed policy turns into a denial. Fail-closed
   * also covers: malformed identifiers, a missing actor id, and a namespace that
   * has never been claimed.
   */
  private async resolveScopedActor(
    actorGroup: KnowledgeActorGroup,
    actorId: string | undefined,
    targetNamespace: string,
  ): Promise<KnowledgeActor> {
    assertKnowledgeIdentifier(targetNamespace, 'namespace');

    // Fail closed: without a trustworthy actor id no scope can be established.
    if (actorId === undefined || actorId.length === 0) {
      return { group: actorGroup, id: actorId, namespaces: [] };
    }
    try {
      assertKnowledgeIdentifier(actorId, 'actorId');
    } catch {
      return { group: actorGroup, id: actorId, namespaces: [] };
    }

    const record = await this.repository.getNamespaceRecord(targetNamespace);
    if (record === undefined) {
      return { group: actorGroup, id: actorId, namespaces: [] };
    }
    const isMember = record.ownerActorId === actorId || record.memberActorIds.includes(actorId);
    return {
      group: actorGroup,
      id: actorId,
      namespaces: isMember ? [targetNamespace] : [],
    };
  }

  /**
   * Sprint 35 F-1 — claims an unclaimed namespace on behalf of the creating
   * actor, then resolves scope exactly as any other operation does.
   *
   * The claim is atomic in the repository, so a forged or concurrent self-grant
   * against an *existing* namespace loses and is subsequently denied by
   * {@link resolveScopedActor}. Claiming is itself permission-gated so a
   * read-only group cannot materialize namespace state.
   */
  private async claimAndScope(
    actorGroup: KnowledgeActorGroup,
    actorId: string | undefined,
    namespace: string,
    at: string,
  ): Promise<KnowledgeActor> {
    assertKnowledgeIdentifier(namespace, 'namespace');
    if (actorId === undefined || actorId.length === 0) {
      return { group: actorGroup, id: actorId, namespaces: [] };
    }
    assertKnowledgeIdentifier(actorId, 'actorId');

    if (!knowledgeGroupHasPermission(actorGroup, KnowledgePermission.Create)) {
      return { group: actorGroup, id: actorId, namespaces: [] };
    }

    const existing = await this.repository.getNamespaceRecord(namespace);
    if (existing === undefined) {
      // `claimed` is intentionally ignored here: a refused claim must not grant
      // scope, and resolveScopedActor re-reads the persisted record so the loser
      // of a concurrent claim resolves to an empty scope (fail-closed).
      await this.repository.claimNamespace(namespace, actorId, at);
    }
    return this.resolveScopedActor(actorGroup, actorId, namespace);
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
