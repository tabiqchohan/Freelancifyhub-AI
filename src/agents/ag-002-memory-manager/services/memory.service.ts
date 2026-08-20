import type { Logger } from 'pino';

import {
  defaultPriorityFor,
  defaultRetentionFor,
  defaultSecurityLevelFor,
  defaultTtlMsFor,
} from '../classification/index.js';
import type { MemoryConfig } from '../config/schema.js';
import { memoryConfig } from '../config/index.js';
import {
  MemoryLifecycleState,
  MemoryPermission,
  type MemoryPriority,
  type MemorySecurityLevel,
  type MemoryType,
} from '../enums/index.js';
import {
  MemoryAccessDeniedError,
  MemoryConfigurationError,
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
import { isMemoryExpired } from '../retention/index.js';
import type {
  MemoryAccessCheckTarget,
  MemoryAccessPolicy,
  MemoryActor,
} from '../security/index.js';
import type {
  IsoTimestamp,
  MemoryContent,
  MemoryMetadata,
  MemoryOwner,
  MemoryRecord,
  MemoryRecordFilter,
  MemorySource,
} from '../types/index.js';
import { createMemoryId, createTraceId, nowIso } from '../utils/ids.js';
import { createMemoryLogger } from '../utils/logger.js';
import { sanitizeMemoryRecordForLogs } from '../utils/sanitize.js';
import {
  validateMemoryActor,
  validateMemoryContent,
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
  retrieveMemory(input: RetrieveMemoryInput): Promise<readonly MemoryRetrievalResult[]>;
}

/** Required dependencies injected into the service (prompt §15). */
export interface MemoryManagerServiceDependencies {
  readonly repository: MemoryRepository;
  readonly accessPolicy: MemoryAccessPolicy;
  readonly lifecycle: MemoryLifecycleContract;
  readonly retrievalEngine: MemoryRetrievalEngine;
}

/** Options for constructing the Memory Manager Service. */
export interface MemoryManagerServiceOptions extends MemoryManagerServiceDependencies {
  readonly config?: MemoryConfig;
  readonly logger?: Logger;
  readonly events?: MemoryEventEmitter;
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

  private readonly repository: MemoryRepository;
  private readonly accessPolicy: MemoryAccessPolicy;
  private readonly lifecycle: MemoryLifecycleContract;
  private readonly retrievalEngine: MemoryRetrievalEngine;

  constructor(options: MemoryManagerServiceOptions) {
    this.assertDependencies(options);
    this.config = options.config ?? memoryConfig;
    this.logger = options.logger ?? createMemoryLogger('memory-service');
    this.events = options.events ?? new InMemoryMemoryEventEmitter();

    this.repository = options.repository;
    this.accessPolicy = options.accessPolicy;
    this.lifecycle = options.lifecycle;
    this.retrievalEngine = options.retrievalEngine;
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
    const createdAt = nowIso();

    this.assertCan(input.actor, MemoryPermission.Write, { namespace, type, securityLevel });

    const draft: MemoryRecord = {
      id: createMemoryId(),
      namespace,
      key,
      type,
      owner,
      content,
      metadata,
      priority,
      securityLevel,
      createdAt,
      updatedAt: createdAt,
      expiresAt: this.expiryOf(createdAt, ttlMs),
      ttlMs,
      retention,
      version: 1,
      lifecycle: MemoryLifecycleState.Created,
      reason,
      traceId,
      source: input.source,
    };

    validateMemoryRecord(draft, this.limits());

    this.lifecycle.transition(MemoryLifecycleState.Created, MemoryLifecycleState.Active);
    const active: MemoryRecord = { ...draft, lifecycle: MemoryLifecycleState.Active };

    await this.repository.create(active);
    this.emit(MemoryEventType.Created, active, input.actor.group);
    this.logger.info(sanitizeMemoryRecordForLogs(active), 'memory created');
    return active;
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

    this.assertCan(input.actor, MemoryPermission.Read, this.targetOf(record));

    if (record.lifecycle === MemoryLifecycleState.Deleted || isMemoryExpired(record)) {
      throw new MemoryNotFoundError(
        `Memory not found (${record.lifecycle}) at ${namespace}/${key}`,
        {
          details: { namespace, key, lifecycle: record.lifecycle },
        },
      );
    }

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
    const updatedAt = nowIso();

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
      updatedAt: nowIso(),
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
      updatedAt: nowIso(),
    };
    validateMemoryRecord(archived, this.limits());
    await this.repository.save(archived);
    this.emit(MemoryEventType.Archived, archived, input.actor.group, { reason });
    this.logger.info(sanitizeMemoryRecordForLogs(archived), 'memory archived');
    return archived;
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
    if (!this.accessPolicy.can({ actor, permission, target })) {
      throw new MemoryAccessDeniedError('Memory access denied', {
        details: {
          permission,
          namespace: target.namespace,
          type: target.type,
          securityLevel: target.securityLevel,
          actorGroup: actor.group,
        },
      });
    }
  }

  private targetOf(record: MemoryRecord): MemoryAccessCheckTarget {
    return {
      namespace: record.namespace,
      type: record.type,
      securityLevel: record.securityLevel,
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
    },
  ): void {
    this.events.emit({
      type,
      traceId:
        extras?.traceId ?? ('traceId' in record ? record.traceId : undefined) ?? createTraceId(),
      occurredAt: nowIso(),
      namespace: record.namespace,
      key: record.key,
      actorGroup,
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
