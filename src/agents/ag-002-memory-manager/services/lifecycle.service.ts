import type { Logger } from 'pino';

import { systemClock, type Clock } from '../clock/index.js';
import type { MemoryConfig } from '../config/schema.js';
import { memoryConfig } from '../config/index.js';
import { MemoryLifecycleState, MemoryPermission } from '../enums/index.js';
import {
  MemoryAccessDeniedError,
  MemoryConfigurationError,
  MemoryNotFoundError,
} from '../errors/index.js';
import {
  InMemoryMemoryEventEmitter,
  MemoryEventType,
  type MemoryEventEmitter,
} from '../events/index.js';
import { transitionMemoryRecord, type MemoryLifecycleContract } from '../lifecycle/index.js';
import type { MemoryRepository } from '../repositories/index.js';
import {
  MemoryRetentionDecision,
  type MemoryRetentionEvaluation,
  type MemoryRetentionEvaluator,
} from '../retention/index.js';
import type { MemoryAccessPolicy, MemoryActor } from '../security/index.js';
import type { MemoryKey, MemoryNamespace, MemoryRecord } from '../types/index.js';
import { createTraceId } from '../utils/ids.js';
import { createMemoryLogger } from '../utils/logger.js';
import { sanitizeMemoryRecordForLogs } from '../utils/sanitize.js';
import {
  validateMemoryActor,
  validateMemoryKey,
  validateMemoryNamespace,
  validateMemoryRecord,
  validateReason,
  validateTraceId,
} from '../validators/index.js';

/** Input to {@link MemoryLifecycleService.evaluate} / {@link MemoryLifecycleService.run}. */
export interface MemoryLifecycleInput {
  readonly actor: MemoryActor;
  readonly namespace: MemoryNamespace;
  readonly key: MemoryKey;
  readonly traceId?: string;
}

/** Input to {@link MemoryLifecycleService.run} (adds the audit reason). */
export interface MemoryLifecycleRunInput extends MemoryLifecycleInput {
  /** Audit reason required for every lifecycle write (AC-MEM-3). */
  readonly reason: string;
}

/** Input to {@link MemoryLifecycleService.runBatch}. */
export interface MemoryLifecycleBatchInput {
  readonly actor: MemoryActor;
  /** Optional namespace to confine the batch to (avoids scanning everything). */
  readonly namespace?: MemoryNamespace;
  /** Candidate cap; defaults to `MEMORY_LIFECYCLE_EVALUATION_BATCH_LIMIT`. */
  readonly limit?: number;
  readonly traceId?: string;
}

/** Outcome of a single lifecycle run (evaluation + optional transition). */
export interface MemoryLifecycleRunResult {
  readonly evaluation: MemoryRetentionEvaluation;
  /** Present only when a transition was applied. */
  readonly record?: MemoryRecord;
  readonly changed: boolean;
}

/** Required dependencies injected into the lifecycle service. */
export interface MemoryLifecycleServiceDependencies {
  readonly repository: MemoryRepository;
  readonly lifecycle: MemoryLifecycleContract;
  readonly retention: MemoryRetentionEvaluator;
  readonly accessPolicy: MemoryAccessPolicy;
}

/** Options for constructing the Memory Lifecycle Service. */
export interface MemoryLifecycleServiceOptions extends MemoryLifecycleServiceDependencies {
  readonly config?: MemoryConfig;
  readonly clock?: Clock;
  readonly logger?: Logger;
  readonly events?: MemoryEventEmitter;
}

/**
 * The AG-002 lifecycle & retention engine (prompt §3, §10, §11). Coordinates
 * deterministic retention evaluation with lifecycle transitions inside the
 * AG-002 service boundary. It is a coordinator only — every dependency is
 * injected. Transitions are version-safe (optimistic concurrency via the
 * repository contract), authorization-checked (delete-class permission) and
 * emit lifecycle events that never carry content. No background workers.
 */
export interface MemoryLifecycleService {
  readonly name: string;
  readonly version: string;
  /** Evaluates retention for a single record without mutating it. */
  evaluate(input: MemoryLifecycleInput): Promise<MemoryRetentionEvaluation>;
  /** Evaluates and, when the retention decision requires it, transitions. */
  run(input: MemoryLifecycleRunInput): Promise<MemoryLifecycleRunResult>;
  /** Evaluates a deterministic, bounded batch of records within actor scope. */
  runBatch(input: MemoryLifecycleBatchInput): Promise<readonly MemoryLifecycleRunResult[]>;
}

/** Default implementation of the AG-002 lifecycle engine. */
export class MemoryLifecycleServiceImpl implements MemoryLifecycleService {
  readonly name = 'memory-lifecycle-service';
  readonly version = '1.0.0';

  private readonly config: MemoryConfig;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly events: MemoryEventEmitter;

  private readonly repository: MemoryRepository;
  private readonly lifecycle: MemoryLifecycleContract;
  private readonly retention: MemoryRetentionEvaluator;
  private readonly accessPolicy: MemoryAccessPolicy;

  constructor(options: MemoryLifecycleServiceOptions) {
    this.assertDependencies(options);
    this.config = options.config ?? memoryConfig;
    this.clock = options.clock ?? systemClock;
    this.logger = options.logger ?? createMemoryLogger('lifecycle-service');
    this.events = options.events ?? new InMemoryMemoryEventEmitter();

    this.repository = options.repository;
    this.lifecycle = options.lifecycle;
    this.retention = options.retention;
    this.accessPolicy = options.accessPolicy;
  }

  async evaluate(input: MemoryLifecycleInput): Promise<MemoryRetentionEvaluation> {
    this.assertEnabled();
    const traceId = this.traceIdOf(input.traceId);
    const record = await this.load(input);
    this.assertCan(input.actor, record);
    const evaluation = this.retention.evaluate(record, this.clock.getNow());
    this.logger.info(
      { namespace: record.namespace, key: record.key, decision: evaluation.decision, traceId },
      'lifecycle evaluated',
    );
    return evaluation;
  }

  async run(input: MemoryLifecycleRunInput): Promise<MemoryLifecycleRunResult> {
    this.assertEnabled();
    const traceId = this.traceIdOf(input.traceId);
    const reason = validateReason(input.reason);
    const record = await this.load(input);
    this.assertCan(input.actor, record);
    const now = this.clock.getNow();
    const evaluation = this.retention.evaluate(record, now);

    const decision = this.effectiveDecision(record, evaluation);
    if (decision === MemoryRetentionDecision.KEEP) {
      return { evaluation, changed: false };
    }

    const to = this.stateFor(decision);
    const result = transitionMemoryRecord(
      record,
      to,
      now.toISOString(),
      traceId,
      reason,
      this.lifecycle,
    );
    validateMemoryRecord(result.record, this.limits());
    const stored = await this.repository.update(
      record.namespace,
      record.key,
      record.version,
      result.record,
    );

    this.emitTransition(decision, result.from, stored, input.actor.group, traceId, reason);
    this.logger.info(
      sanitizeMemoryRecordForLogs(stored),
      `lifecycle transition ${result.from} -> ${result.to}`,
    );
    return { evaluation, record: stored, changed: true };
  }

  async runBatch(input: MemoryLifecycleBatchInput): Promise<readonly MemoryLifecycleRunResult[]> {
    this.assertEnabled();
    const traceId = this.traceIdOf(input.traceId);
    const limit = this.batchLimit(input.limit);
    const namespace =
      input.namespace === undefined ? undefined : validateMemoryNamespace(input.namespace);

    const all = await this.repository.list(namespace === undefined ? undefined : { namespace });
    const candidates = all
      .filter(
        (record) =>
          (record.lifecycle === MemoryLifecycleState.Active ||
            record.lifecycle === MemoryLifecycleState.Expired) &&
          (input.actor.namespaces ?? []).includes(record.namespace),
      )
      .sort((a, b) => {
        const byNamespace = a.namespace.localeCompare(b.namespace);
        return byNamespace !== 0 ? byNamespace : a.key.localeCompare(b.key);
      })
      .slice(0, limit);

    const results: MemoryLifecycleRunResult[] = [];
    for (const record of candidates) {
      const decision = this.retention.evaluate(record, this.clock.getNow()).decision;
      if (decision === MemoryRetentionDecision.KEEP) {
        continue;
      }
      const outcome = await this.run({
        actor: input.actor,
        namespace: record.namespace,
        key: record.key,
        reason: 'lifecycle batch evaluation',
        traceId,
      });
      if (outcome.changed) {
        results.push(outcome);
      }
    }
    this.logger.info(
      { namespace, traceId, candidates: candidates.length, changed: results.length, limit },
      'lifecycle batch evaluated',
    );
    return results;
  }

  private async load(input: MemoryLifecycleInput): Promise<MemoryRecord> {
    const namespace = validateMemoryNamespace(input.namespace);
    const key = validateMemoryKey(input.key);
    const record = await this.repository.get(namespace, key);
    if (record === undefined) {
      throw new MemoryNotFoundError(`Memory not found at namespace ${namespace} key ${key}`, {
        details: { namespace, key },
      });
    }
    return record;
  }

  /** Fails closed at construction when a required dependency is missing. */
  private assertDependencies(options: MemoryLifecycleServiceOptions): void {
    const missing = Object.entries({
      repository: options.repository,
      lifecycle: options.lifecycle,
      retention: options.retention,
      accessPolicy: options.accessPolicy,
    })
      .filter(([, value]) => value === undefined)
      .map(([key]) => key);

    if (missing.length > 0) {
      throw new MemoryConfigurationError(
        `MemoryLifecycleService is missing required dependencies: ${missing.join(', ')}`,
        { details: { missing } },
      );
    }
  }

  private assertEnabled(): void {
    if (!this.config.MEMORY_LIFECYCLE_EVALUATION_ENABLED) {
      throw new MemoryConfigurationError('Lifecycle evaluation is disabled by configuration', {
        details: { key: 'MEMORY_LIFECYCLE_EVALUATION_ENABLED' },
      });
    }
  }

  private assertCan(actor: MemoryActor, record: MemoryRecord): void {
    validateMemoryActor(actor);
    if (
      !this.accessPolicy.can({
        actor,
        permission: MemoryPermission.Delete,
        target: {
          namespace: record.namespace,
          type: record.type,
          securityLevel: record.securityLevel,
        },
      })
    ) {
      throw new MemoryAccessDeniedError('Memory access denied', {
        details: {
          namespace: record.namespace,
          key: record.key,
          type: record.type,
          securityLevel: record.securityLevel,
          actorGroup: actor.group,
        },
      });
    }
  }

  /**
   * An EXPIRED record may only move forward to ARCHIVED/DELETED (spec §5). The
   * evaluator already returns KEEP for the no-op case; this guards the mapping.
   */
  private effectiveDecision(
    record: MemoryRecord,
    evaluation: MemoryRetentionEvaluation,
  ): MemoryRetentionDecision {
    if (
      record.lifecycle === MemoryLifecycleState.Expired &&
      evaluation.decision === MemoryRetentionDecision.EXPIRE
    ) {
      return MemoryRetentionDecision.KEEP;
    }
    return evaluation.decision;
  }

  private stateFor(decision: MemoryRetentionDecision): MemoryLifecycleState {
    switch (decision) {
      case MemoryRetentionDecision.EXPIRE:
        return MemoryLifecycleState.Expired;
      case MemoryRetentionDecision.ARCHIVE:
        return MemoryLifecycleState.Archived;
      case MemoryRetentionDecision.DELETE:
        return MemoryLifecycleState.Deleted;
      default:
        return MemoryLifecycleState.Active;
    }
  }

  private emitTransition(
    decision: MemoryRetentionDecision,
    from: MemoryLifecycleState,
    record: MemoryRecord,
    actorGroup: MemoryActor['group'],
    traceId: string,
    reason: string,
  ): void {
    this.events.emit({
      type: this.eventFor(decision),
      traceId,
      occurredAt: this.clock.getNow().toISOString(),
      namespace: record.namespace,
      key: record.key,
      memoryId: record.id,
      actorGroup,
      version: record.version,
      previousState: from,
      newState: record.lifecycle,
      reason,
    });
  }

  private eventFor(decision: MemoryRetentionDecision): MemoryEventType {
    switch (decision) {
      case MemoryRetentionDecision.EXPIRE:
        return MemoryEventType.Expired;
      case MemoryRetentionDecision.ARCHIVE:
        return MemoryEventType.Archived;
      case MemoryRetentionDecision.DELETE:
        return MemoryEventType.Deleted;
      default:
        return MemoryEventType.Retrieved;
    }
  }

  private limits() {
    return {
      maxContentBytes: this.config.MEMORY_MAX_CONTENT_BYTES,
      maxMetadataKeys: this.config.MEMORY_MAX_METADATA_KEYS,
    };
  }

  private batchLimit(input?: number): number {
    if (input === undefined) {
      return this.config.MEMORY_LIFECYCLE_EVALUATION_BATCH_LIMIT;
    }
    if (!Number.isInteger(input) || input < 1 || input > 1000) {
      throw new MemoryConfigurationError('Batch limit must be an integer between 1 and 1000', {
        details: { limit: input },
      });
    }
    return input;
  }

  private traceIdOf(input?: string): string {
    return input === undefined ? createTraceId() : validateTraceId(input);
  }
}

/** Creates a {@link MemoryLifecycleService} with injected dependencies. */
export function createMemoryLifecycleService(
  options: MemoryLifecycleServiceOptions,
): MemoryLifecycleService {
  return new MemoryLifecycleServiceImpl(options);
}
