import type { MemoryConfig } from '../config/schema.js';
import { memoryConfig } from '../config/index.js';
import { MemoryLifecycleState } from '../enums/index.js';
import { MemoryConfigurationError } from '../errors/index.js';
import { MemoryEventType, type StoredMemoryEvent } from '../events/index.js';
import type { EventLogContract } from '../events/log.js';
import { memoryLifecycle } from '../lifecycle/index.js';
import {
  validateMemoryKey,
  validateMemoryNamespace,
  validateTraceId,
} from '../validators/index.js';
import { createTraceId } from '../utils/ids.js';
import type { IsoTimestamp, MemoryKey, MemoryNamespace } from '../types/index.js';

/**
 * Sprint 9 — Deterministic event-log replay (spec §20, AC-MEM-6).
 *
 * Reconstructs the applicable memory *state/history* for a memory or namespace
 * from the audit event stream. Because StoredMemoryEvent never carries content,
 * replay reconstructs lifecycle state and version history only — never secrets
 * or erased payloads. It validates event ordering, detects malformed/impossible
 * transitions, fails closed on corrupted streams, and honors erasure tombstones:
 * PERMANENTLY ERASED MEMORY IS NEVER RECONSTRUCTED AS ACTIVE.
 */

/** Reconstructed lifecycle state of a memory from its event history. */
export type MemoryReplayState =
  'empty' | 'active' | 'archived' | 'expired' | 'deleted' | 'erased' | 'invalid';

/** A valid pre-existing snapshot state from which to continue replay. */
export type MemoryReplayStartState = Exclude<MemoryReplayState, 'erased' | 'invalid' | 'empty'>;

/** Output of a single replay over one memory key. */
export interface MemoryReplayResult {
  readonly namespace: MemoryNamespace;
  readonly key: MemoryKey;
  /** Reconciled terminal state. `erased` honors the tombstone; `invalid` on corruption. */
  readonly state: MemoryReplayState;
  /** Highest reconstructed version; undefined when no versioned events exist. */
  readonly version?: number;
  /** Timestamp of the final substantive event. */
  readonly lastEventAt?: IsoTimestamp;
  /** The ordered, content-free event history considered during replay. */
  readonly events: readonly StoredMemoryEvent[];
  /** Present only when `state === 'invalid'`: why the stream was rejected. */
  readonly invalidReason?: string;
}

/** Input to replay a single memory key. */
export interface MemoryReplayInput {
  readonly namespace: MemoryNamespace;
  readonly key: MemoryKey;
  /**
   * Optional starting state/version to continue replay from a prior snapshot.
   * When provided, replay resumes from this state instead of `empty`.
   */
  readonly from?: { readonly state: MemoryReplayStartState; readonly version?: number };
  readonly traceId?: string;
}

/** Input to replay every key historically present in a namespace. */
export interface MemoryReplayNamespaceInput {
  readonly namespace: MemoryNamespace;
  readonly traceId?: string;
}

/** Options for constructing the replay service. */
export interface MemoryReplayServiceOptions {
  /** The append-only audit log to replay from. */
  readonly eventLog: EventLogContract;
  readonly config?: MemoryConfig;
}

/** Replay service contract (Sprint 9). */
export interface MemoryReplayService {
  readonly name: string;
  readonly version: string;
  /** Reconstruct the state history of a single memory key. */
  replay(input: MemoryReplayInput): Promise<MemoryReplayResult>;
  /** Reconstruct the state history of every key seen in a namespace. */
  replayNamespace(input: MemoryReplayNamespaceInput): Promise<readonly MemoryReplayResult[]>;
}

/** Default implementation of the replay service. */
export class MemoryReplayServiceImpl implements MemoryReplayService {
  readonly name = 'memory-replay-service';
  readonly version = '1.0.0';

  private readonly eventLog: EventLogContract;
  private readonly config: MemoryConfig;

  constructor(options: MemoryReplayServiceOptions) {
    this.eventLog = options.eventLog;
    this.config = options.config ?? memoryConfig;
  }

  async replay(input: MemoryReplayInput): Promise<MemoryReplayResult> {
    this.assertEnabled();
    const namespace = validateMemoryNamespace(input.namespace);
    const key = validateMemoryKey(input.key);
    const traceId = input.traceId === undefined ? createTraceId() : validateTraceId(input.traceId);

    const events = await this.eventsFor(namespace, key);
    return replayMemoryStream(events, { namespace, key, from: input.from, traceId });
  }

  async replayNamespace(input: MemoryReplayNamespaceInput): Promise<readonly MemoryReplayResult[]> {
    this.assertEnabled();
    const namespace = validateMemoryNamespace(input.namespace);
    const traceId = input.traceId === undefined ? createTraceId() : validateTraceId(input.traceId);

    const keys = await this.keysFor(namespace);
    const results: MemoryReplayResult[] = [];
    for (const key of [...keys].sort()) {
      results.push(await this.replay({ namespace, key, traceId }));
    }
    return results;
  }

  private assertEnabled(): void {
    if (!this.config.MEMORY_EVENT_LOG_REPLAY_ENABLED) {
      throw new MemoryConfigurationError('Event-log replay is disabled by configuration', {
        details: { key: 'MEMORY_EVENT_LOG_REPLAY_ENABLED' },
      });
    }
  }

  private async eventsFor(
    namespace: MemoryNamespace,
    key: MemoryKey,
  ): Promise<readonly StoredMemoryEvent[]> {
    const out: StoredMemoryEvent[] = [];
    let cursor: string | undefined;
    do {
      const page = this.eventLog.query({ namespace, key, maxPageSize: this.pageSize(), cursor });
      out.push(...page.items);
      cursor = page.hasMore ? page.nextCursor : undefined;
    } while (cursor !== undefined);
    return out;
  }

  private async keysFor(namespace: MemoryNamespace): Promise<readonly MemoryKey[]> {
    const keys = new Set<MemoryKey>();
    let cursor: string | undefined;
    do {
      const page = this.eventLog.query({ namespace, maxPageSize: this.pageSize(), cursor });
      for (const event of page.items) {
        keys.add(event.key);
      }
      cursor = page.hasMore ? page.nextCursor : undefined;
    } while (cursor !== undefined);
    return [...keys];
  }

  private pageSize(): number {
    return this.config.MEMORY_EVENT_LOG_MAX_PAGE_SIZE;
  }
}

/** Creates a {@link MemoryReplayService} with injected dependencies. */
export function createMemoryReplayService(
  options: MemoryReplayServiceOptions,
): MemoryReplayService {
  return new MemoryReplayServiceImpl(options);
}

/** Maps a lifecycle event type to its implied target state (content-free). */
function impliedTarget(type: MemoryEventType): MemoryLifecycleState | undefined {
  switch (type) {
    case MemoryEventType.Created:
    case MemoryEventType.Activated:
    case MemoryEventType.Restored:
      return MemoryLifecycleState.Active;
    case MemoryEventType.Expired:
      return MemoryLifecycleState.Expired;
    case MemoryEventType.Archived:
      return MemoryLifecycleState.Archived;
    case MemoryEventType.Deleted:
      return MemoryLifecycleState.Deleted;
    default:
      return undefined;
  }
}

/**
 * Deterministic, pure replay over a supplied (ordered) event stream. Never
 * re-sorts — it validates the given order and rejects non-monotonic sequences
 * (out-of-order / duplicate / corrupted). Filters strictly to the target
 * namespace+key (namespace isolation). Honors the `MEMORY_ERASED` tombstone so
 * erased memory is never reconstructed.
 */
export function replayMemoryStream(
  events: readonly StoredMemoryEvent[],
  input: MemoryReplayInput,
): MemoryReplayResult {
  const namespace = validateMemoryNamespace(input.namespace);
  const key = validateMemoryKey(input.key);

  const relevant = events.filter((event) => event.namespace === namespace && event.key === key);

  if (relevant.length === 0) {
    return { namespace, key, state: 'empty', events: [] };
  }

  let state: MemoryLifecycleState | undefined =
    input.from === undefined ? undefined : startToLifecycle(input.from.state);
  let version: number | undefined = input.from?.version;
  let lastEventAt: IsoTimestamp | undefined;
  let previousSequence = -1;
  const seenIds = new Set<string>();
  const considered: StoredMemoryEvent[] = [];

  for (const event of relevant) {
    // Corruption detection: non-monotonic sequence or duplicate ids.
    if (event.sequence <= previousSequence) {
      return {
        namespace,
        key,
        state: 'invalid',
        version,
        lastEventAt,
        events: considered,
        invalidReason: `non-monotonic event sequence ${event.sequence} after ${previousSequence}`,
      };
    }
    if (seenIds.has(event.eventId)) {
      return {
        namespace,
        key,
        state: 'invalid',
        version,
        lastEventAt,
        events: considered,
        invalidReason: `duplicate event id ${event.eventId}`,
      };
    }
    previousSequence = event.sequence;
    seenIds.add(event.eventId);

    // Erasure tombstone: erased memory is never reconstructed as active.
    if (event.type === MemoryEventType.Erased) {
      return {
        namespace,
        key,
        state: 'erased',
        version,
        lastEventAt: event.occurredAt,
        events: [...considered, event],
      };
    }

    considered.push(event);
    lastEventAt = event.occurredAt;

    const target = impliedTarget(event.type);
    if (target !== undefined) {
      if (state === undefined) {
        state = target;
      } else {
        if (!memoryLifecycle.canTransition(state, target)) {
          return {
            namespace,
            key,
            state: 'invalid',
            version,
            lastEventAt,
            events: considered,
            invalidReason: `impossible lifecycle transition ${state} -> ${target} (event ${event.type})`,
          };
        }
        state = target;
      }
    }

    if (event.version !== undefined && (version === undefined || event.version > version)) {
      version = event.version;
    }
  }

  return {
    namespace,
    key,
    state: stateToReplayState(state),
    version,
    lastEventAt,
    events: considered,
  };
}

/** Converts a reconstructed lifecycle state into the public replay state. */
function stateToReplayState(state: MemoryLifecycleState | undefined): MemoryReplayState {
  switch (state) {
    case MemoryLifecycleState.Active:
      return 'active';
    case MemoryLifecycleState.Archived:
      return 'archived';
    case MemoryLifecycleState.Expired:
      return 'expired';
    case MemoryLifecycleState.Deleted:
      return 'deleted';
    default:
      return 'empty';
  }
}

/** Converts a replay start state back into a lifecycle state. */
function startToLifecycle(state: MemoryReplayStartState): MemoryLifecycleState {
  switch (state) {
    case 'active':
      return MemoryLifecycleState.Active;
    case 'archived':
      return MemoryLifecycleState.Archived;
    case 'expired':
      return MemoryLifecycleState.Expired;
    case 'deleted':
      return MemoryLifecycleState.Deleted;
  }
}
