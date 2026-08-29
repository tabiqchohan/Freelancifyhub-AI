import type { Logger } from 'pino';

import { systemClock, type Clock } from '../clock/index.js';
import {
  defaultPriorityFor,
  defaultRetentionFor,
  defaultSecurityLevelFor,
  defaultTtlMsFor,
} from '../classification/index.js';
import type { MemoryConfig } from '../config/schema.js';
import { memoryConfig } from '../config/index.js';
import {
  MemoryActorGroup,
  MemoryLifecycleState,
  MemoryOwnerKind,
  MemoryPermission,
  MemorySecurityLevel,
  MemoryType,
  type MemoryPriority,
} from '../enums/index.js';
import {
  MemoryAccessDeniedError,
  MemoryConfigurationError,
  MemoryConflictError,
  MemoryLifecycleTransitionError,
  MemoryNotFoundError,
  MemoryStorageError,
} from '../errors/index.js';
import {
  MemoryEventType,
  InMemoryMemoryEventEmitter,
  type MemoryEventEmitter,
} from '../events/index.js';
import type { MemoryLifecycleContract } from '../lifecycle/index.js';
import type { MemoryRepository } from '../repositories/index.js';
import type { MemoryRetrievalEngine, MemoryRetrievalResult } from '../retrieval/index.js';
import {
  DefaultMemoryRetentionEvaluator,
  isMemoryExpired,
  type MemoryRetentionEvaluation,
} from '../retention/index.js';
import type {
  MemoryAccessCheckTarget,
  MemoryAccessPolicy,
  MemoryActor,
} from '../security/index.js';
import type {
  IsoTimestamp,
  MemoryContent,
  MemoryKey,
  MemoryMetadata,
  MemoryNamespace,
  MemoryOwner,
  MemoryRecord,
  MemoryRecordFilter,
  MemoryRetentionPolicy,
  MemorySource,
} from '../types/index.js';
import { createMemoryId, createTraceId } from '../utils/ids.js';
import { createMemoryLogger } from '../utils/logger.js';
import { sanitizeMemoryRecordForLogs } from '../utils/sanitize.js';
import {
  validateMemoryActor,
  validateMemoryContent,
  validateMemoryId,
  validateMemoryKey,
  validateMemoryMetadata,
  validateMemoryNamespace,
  validateMemoryOwner,
  validateMemoryPriority,
  validateMemoryRecord,
  validateMemoryRecordFilter,
  validateMemorySecurityLevel,
  validateMemoryType,
  validateMemoryVersion,
  validateReason,
  validateTraceId,
  validateTtlMs,
} from '../validators/index.js';
import {
  createMemoryLifecycleService,
  type MemoryLifecycleBatchInput,
  type MemoryLifecycleInput,
  type MemoryLifecycleRunInput,
  type MemoryLifecycleRunResult,
  type MemoryLifecycleService,
} from './lifecycle.service.js';
import {
  memoryCreateFingerprint,
  MemoryIdempotencyRegistry,
  optionalIdempotencyKey,
} from './idempotency.js';
import { MemoryCache, CachedMemoryRepository } from '../cache/index.js';
import type { AuthorizationService } from '../security/index.js';
import { createAuthorizationService, MEMORY_ACCESS_MATRIX } from '../security/index.js';

/** Input to {@link MemoryManager.createMemory} (spec §15 Save Memory). */
export interface CreateMemoryInput {
  readonly actor: MemoryActor;
  readonly namespace: string;
  readonly key: string;
  readonly type: MemoryType;
  readonly owner: MemoryOwner;
  readonly content: MemoryContent;
  readonly metadata?: MemoryMetadata;
  readonly priority?: MemoryPriority;
  readonly securityLevel?: MemorySecurityLevel;
  /** TTL in ms; absent uses the type default, 0 disables expiry. */
  readonly ttlMs?: number;
  readonly reason: string;
  readonly traceId?: string;
  readonly source?: MemorySource;
  /** Caller-supplied idempotency key (Sprint 10). Prevents duplicate creation. */
  readonly idempotencyKey?: string;
}

/** Internal validated/fingerprinted create context (Sprint 10). */
interface CreateMemoryInternal {
  readonly namespace: MemoryNamespace;
  readonly key: MemoryKey;
  readonly type: MemoryType;
  readonly owner: MemoryOwner;
  readonly content: MemoryContent;
  readonly metadata: MemoryMetadata;
  readonly priority: MemoryPriority;
  readonly securityLevel: MemorySecurityLevel;
  readonly retention: MemoryRetentionPolicy;
  readonly ttlMs?: number;
  readonly reason: string;
  readonly createdAt: IsoTimestamp;
  readonly fingerprint: string;
  readonly idempotencyKey?: string;
}

/** Input to {@link MemoryManager.getMemory} (spec §15 Load Memory). */
export interface GetMemoryInput {
  readonly actor: MemoryActor;
  readonly namespace: string;
  readonly key: string;
  readonly traceId?: string;
}

/** Input to {@link MemoryManager.updateMemory} (spec §15 Update Memory). */
export interface UpdateMemoryInput {
  readonly actor: MemoryActor;
  readonly namespace: string;
  readonly key: string;
  /** Optimistic-concurrency guard; mismatch throws a conflict (409). */
  readonly expectedVersion: number;
  readonly reason: string;
  readonly content?: MemoryContent;
  readonly metadata?: MemoryMetadata;
  readonly priority?: MemoryPriority;
  readonly securityLevel?: MemorySecurityLevel;
  /** Absent keeps the current TTL; 0 clears expiry. */
  readonly ttlMs?: number;
  readonly traceId?: string;
}

/** Input to {@link MemoryManager.deleteMemory} (spec §15 Delete Memory). */
export interface DeleteMemoryInput {
  readonly actor: MemoryActor;
  readonly namespace: string;
  readonly key: string;
  readonly reason: string;
  /** true performs a physical purge (right-to-forget); false is a logical delete. */
  readonly hard?: boolean;
  readonly traceId?: string;
}

/** Result of {@link MemoryManager.deleteMemory}. */
export interface DeleteMemoryResult {
  readonly key: string;
  readonly status: 'deleted' | 'purged';
}

/** Input to {@link MemoryManager.archiveMemory} (spec §15 Archive Memory). */
export interface ArchiveMemoryInput {
  readonly actor: MemoryActor;
  readonly namespace: string;
  readonly key: string;
  readonly reason: string;
  readonly traceId?: string;
}

/** Input to {@link MemoryManager.restoreMemory} (Sprint 9, spec §5). */
export interface RestoreMemoryInput {
  readonly actor: MemoryActor;
  readonly namespace: string;
  readonly key: string;
  readonly reason: string;
  readonly traceId?: string;
}

/** Input to {@link MemoryManager.eraseMemoryById} (Sprint 9 DSR right-to-forget). */
export interface EraseMemoryByIdInput {
  readonly actor: MemoryActor;
  readonly memoryId: string;
  readonly reason: string;
  readonly traceId?: string;
}

/** Input to {@link MemoryManager.eraseMemoryByNamespace} (Sprint 9 DSR). */
export interface EraseMemoryByNamespaceInput {
  readonly actor: MemoryActor;
  readonly namespace: string;
  readonly reason: string;
  readonly traceId?: string;
}

/** Result of a Sprint 9 erasure operation (never carries the erased payload). */
export interface EraseMemoryResult {
  readonly erased: number;
  readonly status: 'erased';
  readonly scope: { readonly id: string };
}

/** Input to {@link MemoryManager.retrieveMemory} (spec §15 Search Memory). */
export interface RetrieveMemoryInput {
  readonly actor: MemoryActor;
  readonly namespace: string;
  readonly query?: string;
  readonly filters?: MemoryRecordFilter;
  readonly limit?: number;
  readonly traceId?: string;
}

/** The AG-002 memory service contract (prompt §14). */
export interface MemoryManager {
  readonly name: string;
  readonly version: string;
  createMemory(input: CreateMemoryInput): Promise<MemoryRecord>;
  getMemory(input: GetMemoryInput): Promise<MemoryRecord>;
  updateMemory(input: UpdateMemoryInput): Promise<MemoryRecord>;
  deleteMemory(input: DeleteMemoryInput): Promise<DeleteMemoryResult>;
  archiveMemory(input: ArchiveMemoryInput): Promise<MemoryRecord>;
  /** Sprint 9 — restore an ARCHIVED memory back to ACTIVE (version-safe, authorized). */
  restoreMemory(input: RestoreMemoryInput): Promise<MemoryRecord>;
  /** Sprint 9 — physically erase a single memory record by id (DSR right-to-forget). */
  eraseMemoryById(input: EraseMemoryByIdInput): Promise<EraseMemoryResult>;
  /** Sprint 9 — physically erase every record in a namespace (DSR right-to-forget). */
  eraseMemoryByNamespace(input: EraseMemoryByNamespaceInput): Promise<EraseMemoryResult>;
  retrieveMemory(input: RetrieveMemoryInput): Promise<readonly MemoryRetrievalResult[]>;
  /** Evaluates retention for a single record without mutating it (Sprint 2). */
  evaluateLifecycle(input: MemoryLifecycleInput): Promise<MemoryRetentionEvaluation>;
  /** Evaluates and, when required, applies a version-safe lifecycle transition (Sprint 2). */
  runLifecycle(input: MemoryLifecycleRunInput): Promise<MemoryLifecycleRunResult>;
  /** Evaluates a deterministic, bounded lifecycle batch within actor scope (Sprint 2). */
  runBatchLifecycle(input: MemoryLifecycleBatchInput): Promise<readonly MemoryLifecycleRunResult[]>;
}

/** Required dependencies injected into the service (prompt §15). */
export interface MemoryManagerServiceDependencies {
  readonly repository: MemoryRepository;
  readonly accessPolicy: MemoryAccessPolicy;
  readonly lifecycle: MemoryLifecycleContract;
  readonly retrievalEngine: MemoryRetrievalEngine;
  /** Authorization service for access decisions (Sprint 3). */
  readonly authorizationService?: AuthorizationService;
}

/** Options for constructing the Memory Manager Service. */
export interface MemoryManagerServiceOptions extends MemoryManagerServiceDependencies {
  readonly config?: MemoryConfig;
  readonly logger?: Logger;
  readonly events?: MemoryEventEmitter;
  /** Clock abstraction for deterministic timestamps (defaults to the system clock). */
  readonly clock?: Clock;
  /** Injected lifecycle engine; defaults to a fully wired lifecycle service. */
  readonly lifecycleService?: MemoryLifecycleService;
}

/**
 * The AG-002 Memory Manager (spec §3, prompt §14). Coordinates validation,
 * the authorization contract, lifecycle validation and the repository/storage
 * abstraction. It is a coordinator only — every dependency is injected (never
 * constructed internally). Deterministic and transport-independent. No
 * retrieval ranking or persistence provider is implemented in this sprint.
 */
export class MemoryManagerService implements MemoryManager {
  readonly name = 'memory-manager-service';
  readonly version = '1.0.0';

  private readonly config: MemoryConfig;
  private readonly logger: Logger;
  private readonly events: MemoryEventEmitter;
  private readonly clock: Clock;

  private readonly repository: MemoryRepository;
  private readonly accessPolicy: MemoryAccessPolicy;
  private readonly lifecycle: MemoryLifecycleContract;
  private readonly retrievalEngine: MemoryRetrievalEngine;
  private readonly lifecycleService: MemoryLifecycleService;
  private readonly authorizationService: AuthorizationService;
  /** Sprint 10 — idempotent-create registry (process-local, namespace-scoped). */
  private readonly idempotencyRegistry: MemoryIdempotencyRegistry;
  /** Sprint 10 — in-flight guard for concurrent identical creates (key → promise). */
  private readonly idempotencyInFlight = new Map<string, Promise<MemoryRecord>>();

  constructor(options: MemoryManagerServiceOptions) {
    this.assertDependencies(options);
    this.config = options.config ?? memoryConfig;
    this.logger = options.logger ?? createMemoryLogger('memory-service');
    this.events = options.events ?? new InMemoryMemoryEventEmitter();
    this.clock = options.clock ?? systemClock;

    this.repository = this.maybeCacheRepository(options.repository);
    this.accessPolicy = options.accessPolicy;
    this.lifecycle = options.lifecycle;
    this.retrievalEngine = options.retrievalEngine;
    this.lifecycleService =
      options.lifecycleService ??
      createMemoryLifecycleService({
        repository: this.repository,
        lifecycle: options.lifecycle,
        retention: new DefaultMemoryRetentionEvaluator(),
        accessPolicy: options.accessPolicy,
        config: this.config,
        clock: this.clock,
        logger: this.logger,
        events: this.events,
      });
    this.authorizationService = options.authorizationService ?? createAuthorizationService();
    this.idempotencyRegistry = new MemoryIdempotencyRegistry();
  }

  async createMemory(input: CreateMemoryInput): Promise<MemoryRecord> {
    const traceId = this.traceIdOf(input.traceId);
    const namespace = validateMemoryNamespace(input.namespace);
    const key = validateMemoryKey(input.key);
    const type = validateMemoryType(input.type);
    const owner = validateMemoryOwner(input.owner);
    const content = validateMemoryContent(input.content);
    const metadata = validateMemoryMetadata(input.metadata ?? {});
    const priority =
      input.priority === undefined
        ? defaultPriorityFor(type)
        : validateMemoryPriority(input.priority);
    const securityLevel =
      input.securityLevel === undefined
        ? defaultSecurityLevelFor(type)
        : validateMemorySecurityLevel(input.securityLevel);
    const retention = defaultRetentionFor(type);
    const ttlMs =
      input.ttlMs === undefined ? defaultTtlMsFor(type, this.config) : validateTtlMs(input.ttlMs);
    const reason = validateReason(input.reason);
    const createdAt = this.nowIso();

    const idempotencyKey = optionalIdempotencyKey(input.idempotencyKey);
    const fingerprint = memoryCreateFingerprint({ namespace, key, content, metadata });

    const internal: CreateMemoryInternal = {
      namespace,
      key,
      type,
      owner,
      content,
      metadata,
      priority,
      securityLevel,
      retention,
      ttlMs,
      reason,
      createdAt,
      fingerprint,
      idempotencyKey,
    };

    if (idempotencyKey !== undefined) {
      // Serialize concurrent identical creates keyed by (namespace, key) so the
      // second caller deterministically replays the first result instead of
      // racing against the non-atomic in-memory create.
      const guard = `${namespace}\u0000${idempotencyKey}`;
      const inFlight = this.idempotencyInFlight.get(guard);
      if (inFlight !== undefined) {
        const existing = await inFlight;
        if (
          existing.key === key &&
          existing.namespace === namespace &&
          this.recordFingerprintMatches(existing, fingerprint)
        ) {
          this.emit(MemoryEventType.Retrieved, existing, input.actor.group, { traceId });
          return existing;
        }
        throw new MemoryConflictError(
          `Idempotency key ${idempotencyKey} was already used by a different create request`,
          {
            code: 'MEMORY_IDEMPOTENCY_CONFLICT_ERROR',
            details: { namespace, idempotencyKey },
          },
        );
      }
      const run = this.performCreate(input, internal).finally(() => {
        this.idempotencyInFlight.delete(guard);
      });
      this.idempotencyInFlight.set(guard, run);
      return run;
    }

    return this.performCreate(input, internal);
  }

  private async performCreate(
    input: CreateMemoryInput,
    v: CreateMemoryInternal,
  ): Promise<MemoryRecord> {
    const traceId = this.traceIdOf(input.traceId);
    const namespace = v.namespace;
    const key = v.key;
    const idempotencyKey = v.idempotencyKey;
    const fingerprint = v.fingerprint;

    // Idempotency (Sprint 10): a caller-provided key that has already been
    // satisfied returns the existing record without re-creating it or re-emitting.
    if (idempotencyKey !== undefined) {
      const prior = this.idempotencyRegistry.get(namespace, idempotencyKey);
      if (prior !== undefined) {
        if (
          prior.key === key &&
          prior.namespace === namespace &&
          prior.fingerprint === fingerprint
        ) {
          const existing = await this.repository.get(namespace, key);
          if (existing !== undefined) {
            this.emit(MemoryEventType.Retrieved, existing, input.actor.group, { traceId });
            this.logger.info({ namespace, key, idempotency: 'replayed' }, 'memory create replayed');
            return existing;
          }
        }
        throw new MemoryConflictError(
          `Idempotency key ${idempotencyKey} was already used by a different create request`,
          {
            code: 'MEMORY_IDEMPOTENCY_CONFLICT_ERROR',
            details: { namespace, idempotencyKey },
          },
        );
      }
    }

    const draftForAuth: MemoryRecord = {
      id: createMemoryId(),
      namespace: v.namespace,
      key: v.key,
      type: v.type,
      owner: v.owner,
      content: v.content,
      metadata: v.metadata,
      priority: v.priority,
      securityLevel: v.securityLevel,
      createdAt: v.createdAt,
      updatedAt: v.createdAt,
      expiresAt: this.expiryOf(v.createdAt, v.ttlMs),
      ttlMs: v.ttlMs,
      retention: v.retention,
      version: 1,
      lifecycle: MemoryLifecycleState.Created,
      reason: v.reason,
      traceId,
      source: input.source,
    };
    this.assertCan(input.actor, MemoryPermission.Write, this.targetOf(draftForAuth));

    const draft: MemoryRecord = {
      id: createMemoryId(),
      namespace: v.namespace,
      key: v.key,
      type: v.type,
      owner: v.owner,
      content: v.content,
      metadata: v.metadata,
      priority: v.priority,
      securityLevel: v.securityLevel,
      createdAt: v.createdAt,
      updatedAt: v.createdAt,
      expiresAt: this.expiryOf(v.createdAt, v.ttlMs),
      ttlMs: v.ttlMs,
      retention: v.retention,
      version: 1,
      lifecycle: MemoryLifecycleState.Created,
      reason: v.reason,
      traceId,
      source: input.source,
    };

    validateMemoryRecord(draft, this.limits());

    this.lifecycle.transition(MemoryLifecycleState.Created, MemoryLifecycleState.Active);
    const active: MemoryRecord = { ...draft, lifecycle: MemoryLifecycleState.Active };

    let created: MemoryRecord;
    try {
      created = await this.repository.create(active);
    } catch (error) {
      // A concurrent identical create may have won the namespace/key race. If an
      // idempotency key was supplied and the existing record still matches the
      // logical fingerprint, return it rather than surfacing a spurious conflict.
      if (error instanceof MemoryConflictError && idempotencyKey !== undefined) {
        const existing = await this.repository.get(namespace, key);
        if (existing !== undefined && this.recordFingerprintMatches(existing, fingerprint)) {
          this.emit(MemoryEventType.Retrieved, existing, input.actor.group, { traceId });
          return existing;
        }
      }
      throw error;
    }

    if (idempotencyKey !== undefined) {
      this.idempotencyRegistry.set(namespace, idempotencyKey, {
        namespace,
        key,
        fingerprint,
      });
    }

    this.emit(MemoryEventType.Created, created, input.actor.group);
    this.logger.info(sanitizeMemoryRecordForLogs(created), 'memory created');
    return created;
  }

  async getMemory(input: GetMemoryInput): Promise<MemoryRecord> {
    const namespace = validateMemoryNamespace(input.namespace);
    const key = validateMemoryKey(input.key);
    const traceId = this.traceIdOf(input.traceId);

    const record = await this.repository.get(namespace, key);
    if (record === undefined) {
      throw new MemoryNotFoundError(`Memory not found at namespace ${namespace} key ${key}`, {
        details: { namespace, key },
      });
    }

    // Deleted/expired records are invisible (AC-MEM-4) - check before authorization
    if (record.lifecycle === MemoryLifecycleState.Deleted || isMemoryExpired(record)) {
      throw new MemoryNotFoundError(
        `Memory not found (${record.lifecycle}) at ${namespace}/${key}`,
        {
          details: { namespace, key, lifecycle: record.lifecycle },
        },
      );
    }

    this.assertCan(input.actor, MemoryPermission.Read, this.targetOf(record));

    this.emit(MemoryEventType.Retrieved, record, input.actor.group, { traceId });
    this.logger.info({ namespace, key, traceId }, 'memory retrieved');
    return record;
  }

  async updateMemory(input: UpdateMemoryInput): Promise<MemoryRecord> {
    const namespace = validateMemoryNamespace(input.namespace);
    const key = validateMemoryKey(input.key);
    const expectedVersion = validateMemoryVersion(input.expectedVersion);

    const current = await this.repository.get(namespace, key);
    if (current === undefined) {
      throw new MemoryNotFoundError(`Memory not found at namespace ${namespace} key ${key}`, {
        details: { namespace, key },
      });
    }
    if (current.lifecycle === MemoryLifecycleState.Deleted || isMemoryExpired(current)) {
      throw new MemoryNotFoundError(
        `Memory not found (${current.lifecycle}) at ${namespace}/${key}`,
        {
          details: { namespace, key, lifecycle: current.lifecycle },
        },
      );
    }

    this.assertCan(input.actor, MemoryPermission.Update, this.targetOf(current));

    const traceId = this.traceIdOf(input.traceId);
    const reason = validateReason(input.reason);
    const content =
      input.content === undefined ? current.content : validateMemoryContent(input.content);
    const metadata =
      input.metadata === undefined ? current.metadata : validateMemoryMetadata(input.metadata);
    const priority =
      input.priority === undefined ? current.priority : validateMemoryPriority(input.priority);
    const securityLevel =
      input.securityLevel === undefined
        ? current.securityLevel
        : validateMemorySecurityLevel(input.securityLevel);
    const ttlMs = input.ttlMs === undefined ? current.ttlMs : validateTtlMs(input.ttlMs);
    const updatedAt = this.nowIso();

    const next: MemoryRecord = {
      ...current,
      content,
      metadata,
      priority,
      securityLevel,
      ttlMs,
      expiresAt: this.expiryOf(updatedAt, ttlMs),
      updatedAt,
      version: current.version + 1,
      reason,
      traceId,
    };

    validateMemoryRecord(next, this.limits());
    const updated = await this.repository.update(namespace, key, expectedVersion, next);
    this.emit(MemoryEventType.Updated, updated, input.actor.group, {
      previousVersion: current.version,
      reason,
    });
    this.logger.info(sanitizeMemoryRecordForLogs(updated), 'memory updated');
    return updated;
  }

  async deleteMemory(input: DeleteMemoryInput): Promise<DeleteMemoryResult> {
    const namespace = validateMemoryNamespace(input.namespace);
    const key = validateMemoryKey(input.key);
    const traceId = this.traceIdOf(input.traceId);
    const reason = validateReason(input.reason);

    const current = await this.repository.get(namespace, key);
    if (current === undefined) {
      throw new MemoryNotFoundError(`Memory not found at namespace ${namespace} key ${key}`, {
        details: { namespace, key },
      });
    }

    this.assertCan(input.actor, MemoryPermission.Delete, this.targetOf(current));

    if (!this.lifecycle.canTransition(current.lifecycle, MemoryLifecycleState.Deleted)) {
      throw new MemoryLifecycleTransitionError(
        `Cannot delete memory in lifecycle ${current.lifecycle}`,
        { details: { from: current.lifecycle, to: MemoryLifecycleState.Deleted } },
      );
    }

    if (input.hard === true) {
      const removed = await this.repository.delete(namespace, key);
      if (!removed) {
        throw new MemoryStorageError(`Failed to purge memory at ${namespace}/${key}`, {
          details: { namespace, key },
        });
      }
      this.emit(MemoryEventType.Deleted, current, input.actor.group, { reason, hard: true });
      this.logger.info({ namespace, key, traceId, hard: true }, 'memory purged');
      return { key, status: 'purged' };
    }

    const deleted: MemoryRecord = {
      ...current,
      lifecycle: MemoryLifecycleState.Deleted,
      reason,
      traceId,
      updatedAt: this.nowIso(),
    };
    validateMemoryRecord(deleted, this.limits());
    await this.repository.save(deleted);
    this.emit(MemoryEventType.Deleted, deleted, input.actor.group, { reason, hard: false });
    this.logger.info(sanitizeMemoryRecordForLogs(deleted), 'memory deleted');
    return { key, status: 'deleted' };
  }

  async archiveMemory(input: ArchiveMemoryInput): Promise<MemoryRecord> {
    const namespace = validateMemoryNamespace(input.namespace);
    const key = validateMemoryKey(input.key);
    const traceId = this.traceIdOf(input.traceId);
    const reason = validateReason(input.reason);

    const current = await this.repository.get(namespace, key);
    if (current === undefined) {
      throw new MemoryNotFoundError(`Memory not found at namespace ${namespace} key ${key}`, {
        details: { namespace, key },
      });
    }

    this.assertCan(input.actor, MemoryPermission.Delete, this.targetOf(current));

    if (!this.lifecycle.canTransition(current.lifecycle, MemoryLifecycleState.Archived)) {
      throw new MemoryLifecycleTransitionError(
        `Cannot archive memory in lifecycle ${current.lifecycle}`,
        { details: { from: current.lifecycle, to: MemoryLifecycleState.Archived } },
      );
    }

    const archived: MemoryRecord = {
      ...current,
      lifecycle: MemoryLifecycleState.Archived,
      reason,
      traceId,
      updatedAt: this.nowIso(),
    };
    validateMemoryRecord(archived, this.limits());
    await this.repository.save(archived);
    this.emit(MemoryEventType.Archived, archived, input.actor.group, { reason });
    this.logger.info(sanitizeMemoryRecordForLogs(archived), 'memory archived');
    return archived;
  }

  /**
   * Sprint 9 — restore an ARCHIVED memory back to ACTIVE. Authorized with a
   * delete-class privilege (`Delete`), namespace/ownership/security
   * constrained, and version-safe. Idempotent: an already-ACTIVE
   * record is returned unchanged. Permanently erased/deleted memory cannot be
   * restored (the erased record is physically absent → not found; `Deleted` is
   * terminal per the lifecycle contract).
   */
  async restoreMemory(input: RestoreMemoryInput): Promise<MemoryRecord> {
    const namespace = validateMemoryNamespace(input.namespace);
    const key = validateMemoryKey(input.key);
    const traceId = this.traceIdOf(input.traceId);
    const reason = validateReason(input.reason);

    const current = await this.repository.get(namespace, key);
    if (current === undefined) {
      throw new MemoryNotFoundError(`Memory not found at namespace ${namespace} key ${key}`, {
        details: { namespace, key },
      });
    }
    if (current.lifecycle === MemoryLifecycleState.Deleted || isMemoryExpired(current)) {
      throw new MemoryNotFoundError(
        `Memory not found (${current.lifecycle}) at ${namespace}/${key}`,
        {
          details: { namespace, key, lifecycle: current.lifecycle },
        },
      );
    }

    this.assertCan(input.actor, MemoryPermission.Delete, this.targetOf(current));

    // Idempotent: an already-ACTIVE record has nothing to restore.
    if (current.lifecycle === MemoryLifecycleState.Active) {
      return current;
    }

    if (!this.lifecycle.canTransition(current.lifecycle, MemoryLifecycleState.Active)) {
      throw new MemoryLifecycleTransitionError(
        `Cannot restore memory in lifecycle ${current.lifecycle}`,
        { details: { from: current.lifecycle, to: MemoryLifecycleState.Active } },
      );
    }

    const restored: MemoryRecord = {
      ...current,
      lifecycle: MemoryLifecycleState.Active,
      reason,
      traceId,
      updatedAt: this.nowIso(),
      version: current.version + 1,
    };
    validateMemoryRecord(restored, this.limits());
    const stored = await this.repository.update(namespace, key, current.version, restored);
    this.emit(MemoryEventType.Restored, stored, input.actor.group, {
      reason,
      previousVersion: current.version,
    });
    this.logger.info(sanitizeMemoryRecordForLogs(stored), 'memory restored');
    return stored;
  }

  /** Sprint 9 — physically erase a single memory record by id (DSR right-to-forget). */
  async eraseMemoryById(input: EraseMemoryByIdInput): Promise<EraseMemoryResult> {
    this.assertRightToForgetEnabled();
    const memoryId = validateMemoryId(input.memoryId);
    const reason = validateReason(input.reason);
    const traceId = this.traceIdOf(input.traceId);

    const record = await this.repository.getById(memoryId);
    if (record === undefined) {
      // Idempotent: absent (never created or already erased) is a successful no-op.
      return { erased: 0, status: 'erased', scope: { id: memoryId } };
    }

    this.assertCanErase(input.actor, this.targetOf(record));

    const removed = await this.repository.eraseById(memoryId);
    if (!removed) {
      throw new MemoryStorageError(`Failed to erase memory ${memoryId}`, {
        details: { memoryId },
      });
    }
    this.emit(MemoryEventType.Erased, record, input.actor.group, {
      reason,
      memoryId: record.id,
    });
    this.logger.info(
      { memoryId, namespace: record.namespace, key: record.key, traceId, erased: true },
      'memory erased',
    );
    return { erased: 1, status: 'erased', scope: { id: memoryId } };
  }

  /** Sprint 9 — physically erase every record in a namespace (DSR right-to-forget). */
  async eraseMemoryByNamespace(input: EraseMemoryByNamespaceInput): Promise<EraseMemoryResult> {
    this.assertRightToForgetEnabled();
    const namespace = validateMemoryNamespace(input.namespace);
    const reason = validateReason(input.reason);
    const traceId = this.traceIdOf(input.traceId);

    // Conservative DSR authorization: namespace scope + elevated Delete capability.
    if (!(input.actor.namespaces ?? []).includes(namespace)) {
      this.emitSecurityEvent(
        MemoryEventType.EraseDenied,
        {
          namespace,
          type: MemoryType.User,
          securityLevel: MemorySecurityLevel.Internal,
          lifecycle: MemoryLifecycleState.Active,
        },
        input.actor,
        {
          permission: MemoryPermission.Delete,
          denialReason: 'Actor scope does not include the target namespace',
          denialCode: 'SCOPE_VIOLATION',
        },
      );
      throw new MemoryAccessDeniedError('Erase access denied: namespace out of actor scope', {
        details: { namespace, actorGroup: input.actor.group },
      });
    }
    if (
      input.actor.group !== MemoryActorGroup.MemoryManager &&
      input.actor.group !== MemoryActorGroup.Admin
    ) {
      this.emitSecurityEvent(
        MemoryEventType.EraseDenied,
        {
          namespace,
          type: MemoryType.User,
          securityLevel: MemorySecurityLevel.Internal,
          lifecycle: MemoryLifecycleState.Active,
        },
        input.actor,
        {
          permission: MemoryPermission.Delete,
          denialReason: 'DSR erasure requires elevated privileges',
          denialCode: 'INSUFFICIENT_PERMISSION',
        },
      );
      throw new MemoryAccessDeniedError(
        'Erase access denied: DSR erasure requires elevated privileges',
        {
          details: { namespace, actorGroup: input.actor.group },
        },
      );
    }
    this.emitSecurityEvent(
      MemoryEventType.AccessAllowed,
      {
        namespace,
        type: MemoryType.User,
        securityLevel: MemorySecurityLevel.Internal,
        lifecycle: MemoryLifecycleState.Active,
      },
      input.actor,
      {
        permission: MemoryPermission.Delete,
        reason: 'allowed',
      },
    );

    const records = await this.repository.list({ namespace });
    const erased = await this.repository.eraseByNamespace(namespace);
    for (const record of records) {
      this.emit(MemoryEventType.Erased, record, input.actor.group, {
        reason,
        memoryId: record.id,
      });
    }
    this.logger.info({ namespace, traceId, erased, reason }, 'namespace memory erased');
    return { erased, status: 'erased', scope: { id: namespace } };
  }

  async retrieveMemory(input: RetrieveMemoryInput): Promise<readonly MemoryRetrievalResult[]> {
    const namespace = validateMemoryNamespace(input.namespace);
    const traceId = this.traceIdOf(input.traceId);
    const limit = input.limit ?? this.config.MEMORY_RETRIEVAL_MAX_RESULTS;
    const filters =
      input.filters === undefined ? undefined : validateMemoryRecordFilter(input.filters);

    const results = await this.retrievalEngine.search(
      { namespace, query: input.query, filters, limit },
      input.actor.namespaces ?? [],
    );

    const accessible = results.filter((result) =>
      this.accessPolicy.can({
        actor: input.actor,
        permission: MemoryPermission.Read,
        target: this.targetOf(result.record),
      }),
    );

    this.emit(
      MemoryEventType.Retrieved,
      {
        namespace,
        key: 'search',
      },
      input.actor.group,
      { traceId, count: accessible.length },
    );
    this.logger.info({ namespace, traceId, count: accessible.length, limit }, 'memory retrieved');
    return accessible;
  }

  /** Delegates lifecycle evaluation to the wired lifecycle engine (Sprint 2). */
  async evaluateLifecycle(input: MemoryLifecycleInput): Promise<MemoryRetentionEvaluation> {
    return this.lifecycleService.evaluate(input);
  }

  /** Delegates lifecycle run (evaluate + version-safe transition) to the engine (Sprint 2). */
  async runLifecycle(input: MemoryLifecycleRunInput): Promise<MemoryLifecycleRunResult> {
    return this.lifecycleService.run(input);
  }

  /** Delegates the deterministic lifecycle batch to the engine (Sprint 2). */
  async runBatchLifecycle(
    input: MemoryLifecycleBatchInput,
  ): Promise<readonly MemoryLifecycleRunResult[]> {
    return this.lifecycleService.runBatch(input);
  }

  /**
   * Wraps the repository in a read-through cache when caching is enabled.
   * When disabled, returns the repository untouched (transparent mode).
   */
  private maybeCacheRepository(repository: MemoryRepository): MemoryRepository {
    if (!this.config.MEMORY_CACHE_ENABLED) {
      return repository;
    }
    const cache = new MemoryCache<MemoryRecord>({
      enabled: true,
      maxEntries: this.config.MEMORY_CACHE_MAX_ENTRIES,
      ttlMs: this.config.MEMORY_CACHE_TTL_MS,
    });
    return new CachedMemoryRepository(repository, cache);
  }

  /** True when the stored record is logically identical to the create fingerprint. */
  private recordFingerprintMatches(record: MemoryRecord, fingerprint: string): boolean {
    return (
      memoryCreateFingerprint({
        namespace: record.namespace,
        key: record.key,
        content: record.content,
        metadata: record.metadata,
      }) === fingerprint
    );
  }

  /** Fails closed at construction when a required dependency is missing. */
  private assertDependencies(options: MemoryManagerServiceOptions): void {
    const missing = Object.entries({
      repository: options.repository,
      accessPolicy: options.accessPolicy,
      lifecycle: options.lifecycle,
      retrievalEngine: options.retrievalEngine,
    })
      .filter(([, value]) => value === undefined)
      .map(([key]) => key);

    if (missing.length > 0) {
      throw new MemoryConfigurationError(
        `MemoryManagerService is missing required dependencies: ${missing.join(', ')}`,
        { details: { missing } },
      );
    }
  }

  private assertCan(
    actor: MemoryActor,
    permission: MemoryPermission,
    target: MemoryAccessCheckTarget,
  ): void {
    validateMemoryActor(actor);
    const decision = this.authorizationService.authorize({ actor, permission, target });

    if (decision.allowed) {
      this.emitSecurityEvent(MemoryEventType.AccessAllowed, target, actor, {
        permission,
        reason: 'allowed',
      });
    } else {
      this.emitSecurityEvent(MemoryEventType.AccessDenied, target, actor, {
        permission,
        denialReason: decision.reason,
        denialCode: decision.code,
      });
      this.throwForPermission(permission, decision.reason, decision.code, target, actor);
    }
  }

  /**
   * Sprint 9 — dedicated fail-closed authorization for DSR erasure. Erasure is a
   * delete-class, terminal operation that may legitimately target records in any
   * lifecycle (including already-soft-deleted), so it deliberately bypasses the
   * generic LifecycleStatePolicy while still enforcing matrix permission, namespace
   * scope, ownership and security clearance. Cross-tenant erasure is impossible.
   */
  private assertCanErase(actor: MemoryActor, target: MemoryAccessCheckTarget): void {
    validateMemoryActor(actor);
    const deny = (code: string, reason: string): never => {
      this.emitSecurityEvent(MemoryEventType.EraseDenied, target, actor, {
        permission: MemoryPermission.Delete,
        denialReason: reason,
        denialCode: code,
      });
      throw new MemoryAccessDeniedError(reason ?? 'Erase access denied', {
        code,
        details: {
          permission: MemoryPermission.Delete,
          namespace: target.namespace,
          type: target.type,
          actorGroup: actor.group,
        },
      });
    };

    if (!(actor.namespaces ?? []).includes(target.namespace)) {
      deny('SCOPE_VIOLATION', `Actor scope does not include namespace ${target.namespace}`);
    }

    const matrixGranted = (MEMORY_ACCESS_MATRIX[actor.group]?.[target.type] ?? []).includes(
      MemoryPermission.Delete,
    );
    if (!matrixGranted) {
      deny('INSUFFICIENT_PERMISSION', `Actor group lacks Delete permission on ${target.type}`);
    }

    if (target.owner) {
      const { kind, id } = target.owner;
      if (kind === MemoryOwnerKind.System || kind === MemoryOwnerKind.Agent) {
        if (
          actor.group !== MemoryActorGroup.MemoryManager &&
          actor.group !== MemoryActorGroup.Admin
        ) {
          deny('OWNERSHIP_VIOLATION', 'System/agent owned memory requires elevated privileges');
        }
      } else if (kind === MemoryOwnerKind.Project) {
        if (actor.projectIds?.[0] !== id) {
          deny('OWNERSHIP_VIOLATION', `Actor does not own project ${id}`);
        }
      } else if (kind === MemoryOwnerKind.Workspace) {
        if (actor.workspaceId !== id) {
          deny('OWNERSHIP_VIOLATION', `Actor does not own workspace ${id}`);
        }
      } else if (kind === MemoryOwnerKind.Organization) {
        if (actor.organizationId !== id) {
          deny('OWNERSHIP_VIOLATION', `Actor does not own organization ${id}`);
        }
      }
    }

    const actorClearance = actor.securityClearance ?? MemorySecurityLevel.Internal;
    if (
      target.securityLevel === MemorySecurityLevel.Confidential &&
      actorClearance !== MemorySecurityLevel.Confidential
    ) {
      deny(
        'SECURITY_LEVEL_VIOLATION',
        `Actor clearance insufficient for ${target.securityLevel} memory`,
      );
    }

    this.emitSecurityEvent(MemoryEventType.AccessAllowed, target, actor, {
      permission: MemoryPermission.Delete,
      reason: 'allowed',
    });
  }

  private assertRightToForgetEnabled(): void {
    if (!this.config.MEMORY_RIGHT_TO_FORGET_ENABLED) {
      throw new MemoryConfigurationError(
        'DSR right-to-forget erasure is disabled by configuration',
        {
          details: { key: 'MEMORY_RIGHT_TO_FORGET_ENABLED' },
        },
      );
    }
  }

  private throwForPermission(
    permission: MemoryPermission,
    reason: string | undefined,
    code: string | undefined,
    target: MemoryAccessCheckTarget,
    actor: MemoryActor,
  ): never {
    const details = {
      permission,
      namespace: target.namespace,
      type: target.type,
      securityLevel: target.securityLevel,
      actorGroup: actor.group,
      denialCode: code,
    };

    switch (permission) {
      case MemoryPermission.Read:
        throw new MemoryAccessDeniedError(reason ?? 'Read access denied', { details });
      case MemoryPermission.Write:
        throw new MemoryAccessDeniedError(reason ?? 'Write access denied', { details });
      case MemoryPermission.Update:
        throw new MemoryAccessDeniedError(reason ?? 'Update access denied', { details });
      case MemoryPermission.Delete:
        throw new MemoryAccessDeniedError(reason ?? 'Delete access denied', { details });
      case MemoryPermission.Archive:
        throw new MemoryAccessDeniedError(reason ?? 'Archive access denied', { details });
      case MemoryPermission.Restore:
        throw new MemoryAccessDeniedError(reason ?? 'Restore access denied', { details });
      default:
        throw new MemoryAccessDeniedError(reason ?? 'Access denied', { details });
    }
  }

  private emitSecurityEvent(
    type: MemoryEventType,
    target: MemoryAccessCheckTarget,
    actor: MemoryActor,
    extras: {
      permission: MemoryPermission;
      denialReason?: string;
      denialCode?: string;
      reason?: string;
    },
  ): void {
    this.events.emit({
      type,
      traceId: createTraceId(),
      occurredAt: this.nowIso(),
      namespace: target.namespace,
      key: 'authorization-check',
      permission: extras.permission,
      targetType: target.type,
      targetSecurityLevel: target.securityLevel,
      denialReason: extras.denialReason,
      denialCode: extras.denialCode,
      reason: extras.reason,
      actorGroup: actor.group,
      actorId: actor.id,
      actorType: actor.type,
    });
  }

  private targetOf(record: MemoryRecord): MemoryAccessCheckTarget {
    return {
      namespace: record.namespace,
      type: record.type,
      securityLevel: record.securityLevel,
      lifecycle: record.lifecycle,
      owner: record.owner,
    };
  }

  private limits() {
    return {
      maxContentBytes: this.config.MEMORY_MAX_CONTENT_BYTES,
      maxMetadataKeys: this.config.MEMORY_MAX_METADATA_KEYS,
    };
  }

  private expiryOf(createdAt: IsoTimestamp, ttlMs?: number): IsoTimestamp | undefined {
    if (ttlMs === undefined || ttlMs <= 0) {
      return undefined;
    }
    return new Date(new Date(createdAt).getTime() + ttlMs).toISOString();
  }

  private traceIdOf(input?: string): string {
    return input === undefined ? createTraceId() : validateTraceId(input);
  }

  /** Current instant as an ISO-8601 timestamp from the injected clock. */
  private nowIso(): string {
    return this.clock.getNow().toISOString();
  }

  private emit(
    type: MemoryEventType,
    record: MemoryRecord | { namespace: string; key: string },
    actorGroup: MemoryActor['group'],
    extras?: {
      traceId?: string;
      reason?: string;
      hard?: boolean;
      count?: number;
      previousVersion?: number;
      memoryId?: string;
    },
  ): void {
    this.events.emit({
      type,
      traceId:
        extras?.traceId ?? ('traceId' in record ? record.traceId : undefined) ?? createTraceId(),
      occurredAt: this.nowIso(),
      namespace: record.namespace,
      key: record.key,
      actorGroup,
      memoryId: extras?.memoryId ?? ('id' in record ? record.id : undefined),
      version: 'version' in record ? record.version : undefined,
      previousVersion: extras?.previousVersion,
      reason: extras?.reason,
      hard: extras?.hard,
      count: extras?.count,
    });
  }
}

/** Creates a {@link MemoryManager} with injected dependencies (prompt §15). */
export function createMemoryManagerService(options: MemoryManagerServiceOptions): MemoryManager {
  return new MemoryManagerService(options);
}
