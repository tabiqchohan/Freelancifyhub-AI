import { describe, expect, it } from 'vitest';

import { MemoryActorGroup } from '../../../../src/agents/ag-002-memory-manager/enums/index.js';
import {
  MemoryAccessDeniedError,
  MemoryValidationError,
} from '../../../../src/agents/ag-002-memory-manager/errors/index.js';
import {
  InMemoryEventLog,
  MemoryEventType,
} from '../../../../src/agents/ag-002-memory-manager/events/index.js';
import { createMemoryReplayService } from '../../../../src/agents/ag-002-memory-manager/services/index.js';
import { makeActor } from './fixtures.js';

/**
 * Sprint 12 — event-log security regression suite (Phase 5).
 *
 * The event log itself is a content-free, append-only primitive; replay is the
 * consumer-facing path that can reconstruct per-namespace state history. Sprint
 * 12 adds a fail-closed actor gate to replay so an out-of-scope caller cannot
 * reconstruct another namespace's history (namespace isolation), while callers
 * that keep using replay unchanged keep working. These tests prove that
 * enforcement and the log's content-free guarantees.
 */

function seededLog(namespace = 'user:1', keys: string[] = ['k1', 'k2']): InMemoryEventLog {
  const log = new InMemoryEventLog();
  let seq = 0;
  for (const key of keys) {
    log.append({
      type: MemoryEventType.Created,
      traceId: 't',
      occurredAt: `2026-06-01T00:00:${String(seq).padStart(2, '0')}.000Z`,
      namespace,
      key,
    });
    seq += 1;
  }
  return log;
}

describe('event replay authorization (namespace isolation)', () => {
  it('denies replay of a namespace outside the actor scope (fail-closed)', async () => {
    const log = seededLog('user:1', ['k1']);
    const replayService = createMemoryReplayService({ eventLog: log });
    const outsider = makeActor(MemoryActorGroup.Client, ['user:99'], {});

    await expect(
      replayService.replay({ namespace: 'user:1', key: 'k1', actor: outsider }),
    ).rejects.toBeInstanceOf(MemoryAccessDeniedError);
    await expect(
      replayService.replayNamespace({ namespace: 'user:1', actor: outsider }),
    ).rejects.toBeInstanceOf(MemoryAccessDeniedError);
  });

  it('allows replay when the actor scope includes the namespace', async () => {
    const log = seededLog('user:1', ['k1', 'k2']);
    const replayService = createMemoryReplayService({ eventLog: log });
    const insider = makeActor(MemoryActorGroup.Client, ['user:1'], {});

    const result = await replayService.replay({ namespace: 'user:1', key: 'k1', actor: insider });
    expect(result.state).toBe('active');

    const all = await replayService.replayNamespace({ namespace: 'user:1', actor: insider });
    expect(all).toHaveLength(2);
  });

  it('denies replay to an actor with no namespace allow-list (fail-closed)', async () => {
    const log = seededLog('user:1', ['k1']);
    const replayService = createMemoryReplayService({ eventLog: log });
    const noScope = makeActor(MemoryActorGroup.Client, [], {});

    await expect(
      replayService.replay({ namespace: 'user:1', key: 'k1', actor: noScope }),
    ).rejects.toBeInstanceOf(MemoryAccessDeniedError);
  });

  it('rejects an actor that does not pass validation (fail-closed on malformed actor)', async () => {
    const log = seededLog('user:1', ['k1']);
    const replayService = createMemoryReplayService({ eventLog: log });
    const malformed = { namespaces: ['user:1'] } as never;

    await expect(
      replayService.replay({ namespace: 'user:1', key: 'k1', actor: malformed }),
    ).rejects.toBeInstanceOf(MemoryValidationError);
  });

  it('backward compatible: no actor replays unchanged (internal primitive callers)', async () => {
    const log = seededLog('user:1', ['k1']);
    const replayService = createMemoryReplayService({ eventLog: log });
    const result = await replayService.replay({ namespace: 'user:1', key: 'k1' });
    expect(result.state).toBe('active');
  });
});

describe('event replay security invariants', () => {
  it('replay output is content-free (secret metadata never leaks)', async () => {
    const log = new InMemoryEventLog();
    log.append({
      type: MemoryEventType.Created,
      traceId: 't',
      occurredAt: '2026-06-01T00:00:00.000Z',
      namespace: 'user:1',
      key: 'k',
      metadata: { password: 'hunter2', apiKey: 'sk-live-1234567890' },
    });
    const replayService = createMemoryReplayService({ eventLog: log });
    const result = await replayService.replay({ namespace: 'user:1', key: 'k' });
    expect(result.state).toBe('active');
    const serialized = JSON.stringify(result.events);
    // The EventLog sanitizes metadata on append, so secrets never survive.
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('sk-live-1234567890');
  });

  it('replay cannot resurrect erased memory (tombstone honored)', async () => {
    const log = new InMemoryEventLog();
    log.append({
      type: MemoryEventType.Created,
      traceId: 't',
      occurredAt: '2026-06-01T00:00:00.000Z',
      namespace: 'user:1',
      key: 'k',
    });
    log.append({
      type: MemoryEventType.Erased,
      traceId: 't',
      occurredAt: '2026-06-01T00:00:01.000Z',
      namespace: 'user:1',
      key: 'k',
    });
    const replayService = createMemoryReplayService({ eventLog: log });
    const result = await replayService.replay({ namespace: 'user:1', key: 'k' });
    expect(result.state).toBe('erased');
  });
});
