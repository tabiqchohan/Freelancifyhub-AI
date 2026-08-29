import { createHash } from 'node:crypto';
import type { Logger } from 'pino';

import { systemClock, type Clock } from '../clock/index.js';
import { defaultRetentionFor } from '../classification/index.js';
import type { MemoryConfig } from '../config/schema.js';
import { memoryConfig } from '../config/index.js';
import {
  MemoryLifecycleState,
  MemoryPermission,
  MemoryPriority,
  MemorySecurityLevel,
  MemoryType,
} from '../enums/index.js';
import {
  MemoryConfigurationError,
  MemoryConflictError,
  MemoryLifecycleTransitionError,
  MemoryValidationError,
} from '../errors/index.js';
import {
  InMemoryMemoryEventEmitter,
  MemoryEventType,
  type MemoryEventEmitter,
} from '../events/index.js';
import { memoryLifecycle, type MemoryLifecycleContract } from '../lifecycle/index.js';
import type { MemoryRepository } from '../repositories/index.js';
import {
  createAuthorizationService,
  type AuthorizationService,
  type MemoryAccessCheckTarget,
  type MemoryActor,
} from '../security/index.js';
import type { MemoryContent, MemoryId, MemoryNamespace, MemoryRecord } from '../types/index.js';
import { createMemoryId, createTraceId } from '../utils/ids.js';
import { createMemoryLogger } from '../utils/logger.js';
import { sanitizeMemoryRecordForLogs } from '../utils/sanitize.js';
import {
  validateMemoryActor,
  validateMemoryNamespace,
  validateMemoryRecord,
  validateReason,
  validateTraceId,
} from '../validators/index.js';

/**
 * Sprint 5B Memory Consolidation Engine (prompt §1-§18).
 *
 * Deterministically identifies related/duplicate memory records and creates a
 * consolidated record according to an explicit, validated policy. It is NOT an
 * LLM summarizer — consolidation is deterministic, explainable, authorization-
 * aware, lifecycle-aware, security-aware, namespace-aware, non-destructive,
 * auditable, version-safe and dependency-injected.
 */

/** Deterministic priority ordering (higher = more important, prompt §8). */
const PRIORITY_RANK: Readonly<Record<MemoryPriority, number>> = {
  [MemoryPriority.Low]: 1,
  [MemoryPriority.Medium]: 2,
  [MemoryPriority.High]: 3,
  [MemoryPriority.Critical]: 4,
};

/**
 * By default, consolidation never archives or deletes source records (prompt
 * §6 — non-destructive guarantee). Explicitly overriding `archiveSources` is
 * the only way to transition sources to ARCHIVED, and it still requires per-
 * record authorization.
 */
export interface MemoryConsolidationPolicy {
  /** When false, consolidation is a no-op (prompt §18, §5G). */
  readonly enabled: boolean;
  /** Minimum candidate records required to form an eligible group. */
  readonly minRecords: number;
  /** Maximum source records consolidated into a single output record. */
  readonly maxRecordsPerOperation: number;
  /** Memory types eligible to be consolidation sources. */
  readonly allowedTypes: readonly MemoryType[];
  /** Opt-in: archive source records after a successful consolidation. */
  readonly archiveSources: boolean;
}

/** A deterministic group of consolidation candidates (prompt §3, §4). */
export interface MemoryConsolidationGroup {
  readonly namespace: MemoryNamespace;
  readonly type: MemoryType;
  /** Deterministic grouping key (from metadata or default). */
  readonly groupKey: string;
  /** Candidate records; deterministic order, never copied from the caller. */
  readonly records: readonly MemoryRecord[];
  /** True when the group meets the minimum candidate threshold. */
  readonly eligible: boolean;
}

/** Discovery result: candidates + deterministic groups (no writes, prompt §4). */
export interface MemoryConsolidationCandidateResult {
  readonly candidatesDiscovered: number;
  readonly candidatesAuthorized: number;
  readonly candidatesRejected: number;
  readonly filteredByLifecycle: number;
  readonly filteredByScope: number;
  readonly filteredBySecurity: number;
  readonly filteredByType: number;
  readonly groups: readonly MemoryConsolidationGroup[];
  readonly groupsEligible: number;
}

/** Deterministic evaluation of whether consolidation is possible (prompt §2). */
export interface MemoryConsolidationEvaluation {
  readonly possible: boolean;
  readonly reason?: string;
  readonly groupsEligible: number;
  readonly groupsFilteredByMinimum: number;
  readonly groups: readonly MemoryConsolidationGroup[];
}

/** Deterministic statistics for a consolidation run (prompt §16). */
export interface MemoryConsolidationStatistics {
  readonly consolidationId: string;
  readonly namespace: MemoryNamespace;
  readonly candidatesDiscovered: number;
  readonly candidatesAuthorized: number;
  readonly candidatesRejected: number;
  readonly filteredByLifecycle: number;
  readonly filteredByScope: number;
  readonly filteredBySecurity: number;
  readonly filteredByType: number;
  readonly candidatesExcludedByLimit: number;
  readonly groupsFormed: number;
  readonly groupsConsolidated: number;
  readonly groupsSkipped: number;
  readonly recordsCreated: number;
  readonly recordsPreserved: number;
  readonly conflicts: number;
  readonly durationMs: number;
}

/** Result of a consolidation operation (prompt §2). */
export interface MemoryConsolidationResult {
  readonly enabled: boolean;
  /** Consolidated records created by this run (safe identifiers). */
  readonly records: readonly MemoryRecord[];
  /** Deterministic statistics without sensitive contents. */
  readonly statistics: MemoryConsolidationStatistics;
}

/** Input to the consolidation service (reuses the actor/scope contracts). */
export interface MemoryConsolidationRequest {
  readonly actor: MemoryActor;
  /** Scope: consolidation never crosses into another namespace (prompt §9). */
  readonly namespace: MemoryNamespace;
  /** Optional filter constraining eligible source types. */
  readonly types?: readonly MemoryType[];
  /** Optional cap on candidate records scanned. */
  readonly maxCandidates?: number;
  /** Optional policy overrides merged over the service configuration. */
  readonly policy?: Partial<MemoryConsolidationPolicy>;
  /** Audit reason required for the consolidated write (AC-MEM-3). */
  readonly reason: string;
  readonly traceId?: string;
}

/** A single consolidated record source reference (safe, no content). */
export interface MemoryConsolidationSourceRef {
  readonly id: MemoryId;
  readonly key: string;
  readonly version: number;
}

/** Options used to construct the consolidation service. */
export interface MemoryConsolidationServiceOptions {
  readonly repository: MemoryRepository;
  readonly authorizationService?: AuthorizationService;
  readonly config?: MemoryConfig;
  readonly clock?: Clock;
  readonly logger?: Logger;
  readonly events?: MemoryEventEmitter;
  readonly lifecycle?: MemoryLifecycleContract;
}

/** The Memory Consolidation Service contract (prompt §2). */
export interface MemoryConsolidationService {
  readonly name: string;
  readonly version: string;
  /** Discovers and deterministically groups consolidation candidates. */
  findCandidates(request: MemoryConsolidationRequest): Promise<MemoryConsolidationCandidateResult>;
  /** Evaluates whether candidates may be consolidated, without writing. */
  evaluate(request: MemoryConsolidationRequest): Promise<MemoryConsolidationEvaluation>;
  /** Consolidates compatible candidate records (non-destructive by default). */
  consolidate(request: MemoryConsolidationRequest): Promise<MemoryConsolidationResult>;
}

/** Internal grouping type. */
type Group = {
  readonly namespace: MemoryNamespace;
  readonly type: MemoryType;
  readonly groupKey: string;
  readonly records: MemoryRecord[];
  readonly eligible: boolean;
};
/**
 * Sprint 5B Memory Consolidation Service. Deterministic, side-effect-safe
 * consolidation. Never mutates source records, actor context, policy input or
 * candidate arrays. Consolidation output is written as a `LONG_TERM`
 * consolidated-summary record (spec §4) with safe provenance.
 */
export class MemoryConsolidationServiceImpl implements MemoryConsolidationService {
  readonly name = 'memory-consolidation-service';
  readonly version = '1.0.0';

  private readonly config: MemoryConfig;
  private readonly repository: MemoryRepository;
  private readonly authorizationService: AuthorizationService;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly events: MemoryEventEmitter;
  private readonly lifecycle: MemoryLifecycleContract;

  constructor(options: MemoryConsolidationServiceOptions) {
    this.assertDependencies(options);
    this.config = options.config ?? memoryConfig;
    this.repository = options.repository;
    this.authorizationService = options.authorizationService ?? createAuthorizationService();
    this.clock = options.clock ?? systemClock;
    this.logger = options.logger ?? createMemoryLogger('consolidation-service');
    this.events = options.events ?? new InMemoryMemoryEventEmitter();
    this.lifecycle = options.lifecycle ?? memoryLifecycle;
  }

  async findCandidates(
    request: MemoryConsolidationRequest,
  ): Promise<MemoryConsolidationCandidateResult> {
    const policy = this.resolvePolicy(request);
    const discovery = await this.discover(request, policy);
    return {
      candidatesDiscovered: discovery.discovered,
      candidatesAuthorized: discovery.authorized.length,
      candidatesRejected: discovery.rejected,
      filteredByLifecycle: discovery.filteredByLifecycle,
      filteredByScope: discovery.filteredByScope,
      filteredBySecurity: discovery.filteredBySecurity,
      filteredByType: discovery.filteredByType,
      groups: discovery.groups,
      groupsEligible: discovery.groups.filter((g) => g.eligible).length,
    };
  }

  async evaluate(request: MemoryConsolidationRequest): Promise<MemoryConsolidationEvaluation> {
    const policy = this.resolvePolicy(request);
    const discovery = await this.discover(request, policy);
    if (!policy.enabled) {
      return {
        possible: false,
        reason: 'Consolidation is disabled by configuration',
        groupsEligible: 0,
        groupsFilteredByMinimum: 0,
        groups: discovery.groups,
      };
    }
    const eligible = discovery.groups.filter((g) => g.eligible);
    if (eligible.length === 0) {
      return {
        possible: false,
        reason: 'No consolidation groups meet the minimum candidate threshold',
        groupsEligible: 0,
        groupsFilteredByMinimum: discovery.groups.length,
        groups: discovery.groups,
      };
    }
    return {
      possible: true,
      groupsEligible: eligible.length,
      groupsFilteredByMinimum: discovery.groups.length - eligible.length,
      groups: discovery.groups,
    };
  }

  async consolidate(request: MemoryConsolidationRequest): Promise<MemoryConsolidationResult> {
    const traceId = this.traceIdOf(request.traceId);
    const reason = validateReason(request.reason);
    const namespace = validateMemoryNamespace(request.namespace);
    this.assertActor(request.actor);
    const policy = this.resolvePolicy(request);
    const startTime = this.clock.getNow().getTime();
    const consolidationId = `con_${createMemoryId().slice('memory_'.length)}`;

    if (!policy.enabled) {
      return {
        enabled: false,
        records: [],
        statistics: this.statistics({
          consolidationId,
          namespace,
          discovery: {
            discovered: 0,
            authorized: [],
            rejected: 0,
            filteredByLifecycle: 0,
            filteredByScope: 0,
            filteredBySecurity: 0,
            filteredByType: 0,
          },
          groupsFormed: 0,
          groupsConsolidated: 0,
          groupsSkipped: 0,
          recordsCreated: 0,
          recordsPreserved: 0,
          conflicts: 0,
          excludedByLimit: 0,
          startTime,
        }),
      };
    }

    const discovery = await this.discover(request, policy, { traceId });
    const consolidated: MemoryRecord[] = [];
    let groupsConsolidated = 0;
    let groupsSkipped = 0;
    let recordsCreated = 0;
    let conflicts = 0;
    let excludedByLimit = 0;

    for (const group of discovery.groups) {
      if (!group.eligible) {
        groupsSkipped += 1;
        continue;
      }
      const capped = this.applyRecordCap(group.records, policy.maxRecordsPerOperation);
      excludedByLimit += group.records.length - capped.length;
      if (capped.length < policy.minRecords) {
        groupsSkipped += 1;
        continue;
      }
      const outcome = await this.writeConsolidatedRecord({
        group: { ...group, records: capped },
        actor: request.actor,
        reason,
        traceId,
        consolidationId,
        archiveSources: policy.archiveSources,
      });
      if (outcome.created && outcome.record !== undefined) {
        recordsCreated += 1;
        consolidated.push(outcome.record);
      } else if (outcome.conflict) {
        conflicts += 1;
      }
      groupsConsolidated += 1;
    }

    this.logger.info(
      {
        consolidationId,
        namespace,
        traceId,
        groupsConsolidated,
        recordsCreated,
        conflicts,
      },
      'memory consolidation completed',
    );

    return {
      enabled: true,
      records: consolidated,
      statistics: this.statistics({
        consolidationId,
        namespace,
        discovery,
        groupsFormed: discovery.groups.length,
        groupsConsolidated,
        groupsSkipped,
        recordsCreated,
        recordsPreserved: discovery.authorized.length,
        conflicts,
        excludedByLimit,
        startTime,
      }),
    };
  }

  /** Builds a consolidated LONG_TERM record from a group's sources. */
  private buildConsolidatedRecord(
    group: Group,
    context: {
      actor: MemoryActor;
      reason: string;
      traceId: string;
      consolidationId: string;
    },
  ): { record: MemoryRecord; sourceIds: readonly MemoryId[] } {
    const sources = [...group.records].sort((a, b) => this.compareRecords(a, b));
    const best = sources[0];
    if (best === undefined) {
      throw new MemoryValidationError('Cannot consolidate an empty group', {
        code: 'EMPTY_CONSOLIDATION_GROUP',
      });
    }
    const now = this.clock.getNow().toISOString();
    const owner = best.owner;
    const priority = this.mergePriority(sources);
    const securityLevel = this.mergeSecurityLevel(sources);
    const retention = defaultRetentionFor(MemoryType.LongTerm);
    const content = this.mergeContent(sources);
    const sourceIds = sources.map((s) => s.id);
    const sourceRefs = sources.map((s) => ({
      id: s.id,
      key: s.key,
      version: s.version,
    }));

    const record: MemoryRecord = {
      id: createMemoryId(),
      namespace: group.namespace,
      key: this.consolidatedKey(group),
      type: MemoryType.LongTerm,
      owner,
      content,
      metadata: {
        consolidation: {
          consolidationId: context.consolidationId,
          groupKey: group.groupKey,
          sourceCount: sources.length,
          sources: sourceRefs,
        },
      },
      priority,
      securityLevel,
      createdAt: now,
      updatedAt: now,
      retention,
      version: 1,
      lifecycle: MemoryLifecycleState.Active,
      reason: context.reason,
      traceId: context.traceId,
      source: {
        kind: 'summarization',
        reference: context.consolidationId,
      },
    };
    return { record, sourceIds };
  }

  private async writeConsolidatedRecord(context: {
    group: Group;
    actor: MemoryActor;
    reason: string;
    traceId: string;
    consolidationId: string;
    archiveSources: boolean;
  }): Promise<{ created: boolean; conflict: boolean; record?: MemoryRecord }> {
    // Authorize the write of the consolidated LONG_TERM record (fail-closed).
    this.assertCan(context.actor, MemoryPermission.Write, {
      namespace: context.group.namespace,
      type: MemoryType.LongTerm,
      securityLevel: this.mergeSecurityLevel(context.group.records),
      lifecycle: MemoryLifecycleState.Active,
      ...(context.group.records[0] !== undefined ? { owner: context.group.records[0].owner } : {}),
    });

    const built = this.buildConsolidatedRecord(context.group, context);
    validateMemoryRecord(built.record, this.limits());

    let stored: MemoryRecord;
    try {
      stored = await this.repository.create(built.record);
    } catch (error) {
      // Idempotency: the same deterministic consolidation already exists.
      if (error instanceof MemoryConflictError) {
        const existing = await this.repository.get(context.group.namespace, built.record.key);
        if (existing !== undefined && this.isSameConsolidation(existing, built.record, context)) {
          return { created: false, conflict: true, record: existing };
        }
        throw error;
      }
      throw error;
    }

    this.emitConsolidationEvent(stored, {
      actor: context.actor,
      traceId: context.traceId,
      consolidationId: context.consolidationId,
      sourceIds: built.sourceIds,
    });
    this.logger.info(sanitizeMemoryRecordForLogs(stored), 'memory consolidated');

    if (context.archiveSources) {
      await this.archiveSources(
        context.group.records,
        context.actor,
        context.reason,
        context.traceId,
      );
    }
    return { created: true, conflict: false, record: stored };
  }

  private async archiveSources(
    records: readonly MemoryRecord[],
    actor: MemoryActor,
    reason: string,
    traceId: string,
  ): Promise<void> {
    for (const source of records) {
      if (source.lifecycle !== MemoryLifecycleState.Active) {
        continue;
      }
      this.assertCan(actor, MemoryPermission.Delete, {
        namespace: source.namespace,
        type: source.type,
        securityLevel: source.securityLevel,
        lifecycle: source.lifecycle,
        owner: source.owner,
      });
      if (!this.lifecycle.canTransition(source.lifecycle, MemoryLifecycleState.Archived)) {
        throw new MemoryLifecycleTransitionError(
          `Cannot archive source memory in lifecycle ${source.lifecycle}`,
          { details: { from: source.lifecycle, to: MemoryLifecycleState.Archived } },
        );
      }
      const archived: MemoryRecord = {
        ...source,
        lifecycle: MemoryLifecycleState.Archived,
        updatedAt: this.clock.getNow().toISOString(),
        reason,
        traceId,
      };
      validateMemoryRecord(archived, this.limits());
      const stored = await this.repository.save(archived);
      this.events.emit({
        type: MemoryEventType.Archived,
        traceId,
        occurredAt: this.clock.getNow().toISOString(),
        namespace: stored.namespace,
        key: stored.key,
        memoryId: stored.id,
        actorGroup: actor.group,
        version: stored.version,
        previousState: MemoryLifecycleState.Active,
        newState: MemoryLifecycleState.Archived,
        reason,
      });
    }
  }

  private mergeContent(sources: readonly MemoryRecord[]): MemoryContent {
    const first = JSON.stringify(sources[0]?.content);
    const identical = sources.every((s) => JSON.stringify(s.content) === first);
    if (identical) {
      return sources[0]?.content ?? { consolidated: true };
    }
    // Non-LLM, deterministic best representation (never downgrades priority).
    return sources[0]?.content ?? { consolidated: true };
  }

  private mergePriority(sources: readonly MemoryRecord[]): MemoryPriority {
    let highest = sources[0]?.priority ?? MemoryPriority.Low;
    for (const s of sources) {
      if ((PRIORITY_RANK[s.priority] ?? 0) > (PRIORITY_RANK[highest] ?? 0)) {
        highest = s.priority;
      }
    }
    return highest;
  }

  private mergeSecurityLevel(sources: readonly MemoryRecord[]): MemorySecurityLevel {
    if (sources.some((s) => s.securityLevel === MemorySecurityLevel.Confidential)) {
      return MemorySecurityLevel.Confidential;
    }
    return MemorySecurityLevel.Internal;
  }

  private compareRecords(a: MemoryRecord, b: MemoryRecord): number {
    const priDiff = (PRIORITY_RANK[b.priority] ?? 0) - (PRIORITY_RANK[a.priority] ?? 0);
    if (priDiff !== 0) return priDiff;
    if (b.version !== a.version) return b.version - a.version;
    return `${a.namespace}:${a.key}`.localeCompare(`${b.namespace}:${b.key}`);
  }

  private consolidatedKey(group: Group): string {
    const digest = createHash('sha256')
      .update(`${group.namespace}\u0000${group.type}\u0000${group.groupKey}`)
      .digest('hex');
    return `consolidated_${digest}`;
  }

  private isSameConsolidation(
    existing: MemoryRecord,
    candidate: MemoryRecord,
    context: { consolidationId: string },
  ): boolean {
    const existingConsolidation = existing.metadata?.consolidation as
      { consolidationId?: unknown; sources?: unknown } | undefined;
    if (
      existing.key !== candidate.key ||
      existing.namespace !== candidate.namespace ||
      (existingConsolidation?.consolidationId !== context.consolidationId &&
        existing.source?.kind !== 'summarization')
    ) {
      return false;
    }
    // Sprint 10 — stale-source detection: an existing consolidation is only
    // "the same" when its source provenance still matches the current sources.
    // If a source was updated (version bumped) after consolidation, the stored
    // result is stale and must not be silently returned as fresh.
    return this.sourcesMatch(existingConsolidation?.sources, candidate);
  }

  /** True when the existing consolidated provenance matches the candidate sources. */
  private sourcesMatch(existingSources: unknown, candidate: MemoryRecord): boolean {
    const candidateMeta = candidate.metadata?.consolidation as
      { sources?: { id?: unknown; version?: unknown }[] } | undefined;
    const candidateSources = candidateMeta?.sources ?? [];
    if (!Array.isArray(existingSources)) {
      // Legacy consolidated records without provenance are treated as matching,
      // preserving backward-compatible idempotency for pre-Sprint-10 records.
      return true;
    }
    const toKey = (list: { id?: unknown; version?: unknown }[]): string[] =>
      list.map((s) => `${String(s.id)}@${String(s.version)}`).sort();
    const a = toKey(existingSources as { id?: unknown; version?: unknown }[]);
    const b = toKey(candidateSources as { id?: unknown; version?: unknown }[]);
    if (a.length !== b.length) {
      return false;
    }
    return a.every((value, i) => value === b[i]);
  }

  private applyRecordCap(records: readonly MemoryRecord[], cap: number): MemoryRecord[] {
    if (cap <= 0 || records.length <= cap) {
      return [...records];
    }
    return [...records].sort((a, b) => this.compareRecords(a, b)).slice(0, cap);
  }

  private async discover(
    request: MemoryConsolidationRequest,
    policy: MemoryConsolidationPolicy,
    context?: { traceId?: string },
  ): Promise<{
    discovered: number;
    authorized: MemoryRecord[];
    rejected: number;
    filteredByLifecycle: number;
    filteredByScope: number;
    filteredBySecurity: number;
    filteredByType: number;
    groups: Group[];
  }> {
    const namespace = validateMemoryNamespace(request.namespace);
    this.assertActor(request.actor);
    const all = await this.repository.list({ namespace });
    const allowedTypes = new Set(policy.allowedTypes);
    const requestTypes = request.types === undefined ? undefined : new Set(request.types);

    let discovered = 0;
    let filteredByLifecycle = 0;
    let filteredByType = 0;
    let filteredByScope = 0;
    let filteredBySecurity = 0;
    let rejected = 0;

    const authorized: MemoryRecord[] = [];
    for (const record of all) {
      if (requestTypes !== undefined && !requestTypes.has(record.type)) {
        filteredByType += 1;
        continue;
      }
      if (!allowedTypes.has(record.type)) {
        filteredByType += 1;
        continue;
      }
      // Already-consolidated artifacts are never re-consolidated (idempotency).
      if (record.source?.kind === 'summarization') {
        filteredByType += 1;
        continue;
      }
      if (record.lifecycle !== MemoryLifecycleState.Active || this.isExpired(record)) {
        filteredByLifecycle += 1;
        continue;
      }
      discovered += 1;

      const decision = this.authorizationService.authorize({
        actor: request.actor,
        permission: MemoryPermission.Read,
        target: {
          namespace: record.namespace,
          type: record.type,
          securityLevel: record.securityLevel,
          lifecycle: record.lifecycle,
          owner: record.owner,
        },
      });
      if (!decision.allowed) {
        rejected += 1;
        if (decision.code === 'SCOPE_VIOLATION' || decision.code === 'MISSING_SCOPE') {
          filteredByScope += 1;
        } else if (decision.code === 'SECURITY_LEVEL_VIOLATION') {
          filteredBySecurity += 1;
        }
        continue;
      }
      authorized.push(record);
    }

    const groups = this.groupCandidates(authorized, policy.minRecords);
    this.logger.info(
      {
        namespace,
        traceId: context?.traceId,
        discovered,
        authorized: authorized.length,
        groups: groups.length,
      },
      'consolidation candidates discovered',
    );
    return {
      discovered,
      authorized,
      rejected,
      filteredByLifecycle,
      filteredByScope,
      filteredBySecurity,
      filteredByType,
      groups,
    };
  }

  private groupCandidates(records: readonly MemoryRecord[], minRecords: number): Group[] {
    const ordered = [...records].sort((a, b) => this.compareRecords(a, b));
    const buckets = new Map<string, Group>();
    for (const record of ordered) {
      const groupKey = this.groupKeyOf(record);
      const bucketKey = `${record.namespace}\u0000${record.type}\u0000${groupKey}`;
      let group = buckets.get(bucketKey);
      if (group === undefined) {
        group = {
          namespace: record.namespace,
          type: record.type,
          groupKey,
          records: [],
          eligible: false,
        };
        buckets.set(bucketKey, group);
      }
      group.records.push(record);
    }
    const groups = [...buckets.values()];
    for (const group of groups) {
      (group as { eligible: boolean }).eligible = group.records.length >= minRecords;
    }
    return groups.sort((a, b) => {
      const byType = a.type.localeCompare(b.type);
      return byType !== 0 ? byType : a.groupKey.localeCompare(b.groupKey);
    });
  }

  private groupKeyOf(record: MemoryRecord): string {
    const value = record.metadata?.consolidationGroup;
    return typeof value === 'string' ? value : '';
  }

  private resolvePolicy(request: MemoryConsolidationRequest): MemoryConsolidationPolicy {
    const base: MemoryConsolidationPolicy = {
      enabled: this.config.MEMORY_CONSOLIDATION_ENABLED,
      minRecords: this.config.MEMORY_CONSOLIDATION_MIN_RECORDS,
      maxRecordsPerOperation: this.config.MEMORY_CONSOLIDATION_MAX_RECORDS,
      allowedTypes: [...this.config.MEMORY_CONSOLIDATION_ALLOWED_TYPES],
      archiveSources: false,
    };
    if (request.policy === undefined) {
      return base;
    }
    const merged: MemoryConsolidationPolicy = { ...base, ...request.policy };
    if (merged.allowedTypes.length === 0) {
      throw new MemoryValidationError(
        'Consolidation policy requires at least one allowed memory type',
        { code: 'INVALID_POLICY' },
      );
    }
    if (merged.minRecords < 1 || merged.maxRecordsPerOperation < 1) {
      throw new MemoryValidationError('Consolidation thresholds must be positive integers', {
        code: 'INVALID_POLICY',
        details: {
          minRecords: merged.minRecords,
          maxRecordsPerOperation: merged.maxRecordsPerOperation,
        },
      });
    }
    if (merged.maxRecordsPerOperation < merged.minRecords) {
      throw new MemoryValidationError(
        'Consolidation maxRecordsPerOperation cannot be below minRecords',
        { code: 'INVALID_POLICY' },
      );
    }
    return merged;
  }

  private assertActor(actor: MemoryActor): void {
    validateMemoryActor(actor);
  }

  private assertCan(
    actor: MemoryActor,
    permission: MemoryPermission,
    target: MemoryAccessCheckTarget,
  ): void {
    const decision = this.authorizationService.authorize({ actor, permission, target });
    if (!decision.allowed) {
      throw new MemoryValidationError(decision.reason ?? 'Consolidation authorization denied', {
        code: decision.code ?? 'CONSOLIDATION_AUTHORIZATION_DENIED',
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

  private emitConsolidationEvent(
    record: MemoryRecord,
    context: {
      actor: MemoryActor;
      traceId: string;
      consolidationId: string;
      sourceIds: readonly MemoryId[];
    },
  ): void {
    this.events.emit({
      type: MemoryEventType.MemoryConsolidated,
      traceId: context.traceId,
      occurredAt: this.clock.getNow().toISOString(),
      namespace: record.namespace,
      key: record.key,
      memoryId: record.id,
      actorGroup: context.actor.group,
      actorId: context.actor.id,
      actorType: context.actor.type,
      version: record.version,
      reason: record.reason,
      consolidationId: context.consolidationId,
      sourceIds: context.sourceIds,
      outputId: record.id,
    });
  }

  private statistics(config: {
    consolidationId: string;
    namespace: MemoryNamespace;
    discovery: {
      discovered: number;
      authorized: readonly MemoryRecord[];
      rejected: number;
      filteredByLifecycle: number;
      filteredByScope: number;
      filteredBySecurity: number;
      filteredByType: number;
    };
    groupsFormed: number;
    groupsConsolidated: number;
    groupsSkipped: number;
    recordsCreated: number;
    recordsPreserved: number;
    conflicts: number;
    excludedByLimit: number;
    startTime: number;
  }): MemoryConsolidationStatistics {
    return {
      consolidationId: config.consolidationId,
      namespace: config.namespace,
      candidatesDiscovered: config.discovery.discovered,
      candidatesAuthorized: config.discovery.authorized.length,
      candidatesRejected: config.discovery.rejected,
      filteredByLifecycle: config.discovery.filteredByLifecycle,
      filteredByScope: config.discovery.filteredByScope,
      filteredBySecurity: config.discovery.filteredBySecurity,
      filteredByType: config.discovery.filteredByType,
      candidatesExcludedByLimit: config.excludedByLimit,
      groupsFormed: config.groupsFormed,
      groupsConsolidated: config.groupsConsolidated,
      groupsSkipped: config.groupsSkipped,
      recordsCreated: config.recordsCreated,
      recordsPreserved: config.recordsPreserved,
      conflicts: config.conflicts,
      durationMs: this.clock.getNow().getTime() - config.startTime,
    };
  }

  private isExpired(record: MemoryRecord): boolean {
    if (record.expiresAt === undefined) {
      return false;
    }
    return new Date(record.expiresAt).getTime() <= this.clock.getNow().getTime();
  }

  private limits() {
    return {
      maxContentBytes: this.config.MEMORY_MAX_CONTENT_BYTES,
      maxMetadataKeys: this.config.MEMORY_MAX_METADATA_KEYS,
    };
  }

  private traceIdOf(input?: string): string {
    return input === undefined ? createTraceId() : validateTraceId(input);
  }

  /** Fails closed at construction when a required dependency is missing. */
  private assertDependencies(options: MemoryConsolidationServiceOptions): void {
    if (options.repository === undefined) {
      throw new MemoryConfigurationError(
        'MemoryConsolidationService is missing required dependencies: repository',
        { details: { missing: ['repository'] } },
      );
    }
  }
}

/** Creates a {@link MemoryConsolidationService} with injected dependencies. */
export function createMemoryConsolidationService(
  options: MemoryConsolidationServiceOptions,
): MemoryConsolidationService {
  return new MemoryConsolidationServiceImpl(options);
}
