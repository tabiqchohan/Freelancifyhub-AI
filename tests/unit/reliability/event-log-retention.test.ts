/**
 * Sprint 34 §17/§19 — bounded event-log retention regression tests.
 *
 * Every in-memory event log in the system now enforces a FIFO retention cap
 * (`maxStoredEvents`, default 20_000) so sustained traffic cannot grow the
 * audit trail without bound. These tests pin the shared contract:
 *
 *  - the retained count NEVER exceeds the cap (append AND appendBatch),
 *  - eviction drops the OLDEST events first (byId stops resolving them),
 *  - sequence numbers keep rising so cursors/dedupe stay valid.
 */

import { describe, expect, it } from 'vitest';

import {
  InMemoryEventLog,
  MemoryEventType,
  type MemoryEvent,
} from '../../../src/agents/ag-002-memory-manager/index.js';
import {
  KnowledgeActorGroup,
  KnowledgeAuditEventType,
  createKnowledgeEventLog,
} from '../../../src/agents/ag-003-knowledge-manager/index.js';
import {
  ToolActorGroup,
  ToolEventType,
  createToolEventLog,
} from '../../../src/agents/ag-004-tool-manager/index.js';
import {
  AgenticEventLog,
  operationStartedEvent,
} from '../../../src/agents/runtime/agentic/events.js';
import { LLMEventLog, startedEvent } from '../../../src/llm/events/index.js';

const T0 = '2026-01-01T00:00:00.000Z';
const CAP = 3;

describe('AG-002 event log bounded retention (Sprint 34)', () => {
  it('evicts the oldest events once the cap is exceeded', () => {
    let n = 0;
    const log = new InMemoryEventLog({
      maxStoredEvents: CAP,
      eventIdFactory: () => `evt_${String(++n).padStart(4, '0')}`,
    });
    const append = (): string => {
      const stored = log.append({
        type: MemoryEventType.Created,
        traceId: 'trace_1',
        occurredAt: T0,
        namespace: 'user:1',
        key: 'theme',
      } as MemoryEvent);
      return stored.eventId;
    };

    const ids = [append(), append(), append(), append(), append()];

    expect(log.count()).toBe(CAP);
    // The two oldest are evicted; the newest three remain resolvable.
    expect(log.getById(ids[0]!)).toBeUndefined();
    expect(log.getById(ids[1]!)).toBeUndefined();
    expect(log.getById(ids[2]!)).toBeDefined();
    expect(log.getById(ids[4]!)).toBeDefined();
  });

  it('keeps sequence numbers rising across evictions', () => {
    let n = 0;
    const log = new InMemoryEventLog({
      maxStoredEvents: 2,
      eventIdFactory: () => `evt_${String(++n).padStart(4, '0')}`,
    });
    const sequences: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const stored = log.append({
        type: MemoryEventType.Created,
        traceId: 'trace_1',
        occurredAt: T0,
        namespace: 'user:1',
        key: 'theme',
      } as MemoryEvent);
      sequences.push(stored.sequence);
    }
    expect(log.count()).toBe(2);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(new Set(sequences).size).toBe(5);
    // Retention dropped the oldest entries, not the newest.
    const latest = log.latest(1)[0]!;
    expect(latest.sequence).toBe(sequences[4]);
  });

  it('enforces the cap for appendBatch as well', () => {
    let n = 0;
    const log = new InMemoryEventLog({
      maxStoredEvents: CAP,
      maxBatchSize: 10,
      eventIdFactory: () => `evt_${String(++n).padStart(4, '0')}`,
    });
    const batch = Array.from({ length: 8 }, () => ({
      type: MemoryEventType.Created,
      traceId: 'trace_1',
      occurredAt: T0,
      namespace: 'user:1',
      key: 'theme',
    })) as MemoryEvent[];
    log.appendBatch(batch);
    expect(log.count()).toBe(CAP);
  });
});

describe('AG-003 event log bounded retention (Sprint 34)', () => {
  it('never retains more than the configured cap', () => {
    const log = createKnowledgeEventLog({ maxStoredEvents: CAP });
    const ids: string[] = [];
    for (let i = 0; i < CAP + 2; i += 1) {
      const stored = log.append({
        eventId: `kvev_${i}`,
        type: KnowledgeAuditEventType.Created,
        namespace: 'user:1',
        knowledgeId: `knowledge_${i}`,
        actorGroup: KnowledgeActorGroup.KnowledgeManager,
        actorId: 'km-1',
        occurredAt: T0,
        traceId: 'trace-1',
      });
      ids.push(stored.eventId);
    }
    expect(log.count()).toBe(CAP);
    expect(log.getById(ids[0]!)).toBeUndefined();
    expect(log.getById(ids[CAP + 1]!)).toBeDefined();
  });
});

describe('AG-004 event log bounded retention (Sprint 34)', () => {
  it('never retains more than the configured cap', () => {
    const log = createToolEventLog({ maxStoredEvents: CAP });
    const ids: string[] = [];
    for (let i = 0; i < CAP + 2; i += 1) {
      const stored = log.append({
        type: ToolEventType.ExecutionSucceeded,
        traceId: 'trace-1',
        occurredAt: T0,
        namespace: 'default',
        toolId: 'tool:x:v1.0.0',
        toolName: 'x',
        toolVersion: '1.0.0',
        executionId: `texec_${i}`,
        actorGroup: ToolActorGroup.Orchestrator,
        actorId: 'o-1',
      } as never);
      ids.push(stored.eventId);
    }
    expect(log.count()).toBe(CAP);
    expect(log.getById(ids[0]!)).toBeUndefined();
    expect(log.getById(ids[CAP + 1]!)).toBeDefined();
  });
});

describe('Agentic event log bounded retention (Sprint 34)', () => {
  it('never retains more than the configured cap', () => {
    const log = new AgenticEventLog({ maxStoredEvents: CAP });
    const ids: string[] = [];
    for (let i = 0; i < CAP + 2; i += 1) {
      const stored = log.append(
        operationStartedEvent({
          occurredAt: T0,
          traceId: 'trace-1',
          executionId: `exec_${i}`,
        }),
      );
      ids.push(stored.eventId);
    }
    expect(log.count()).toBe(CAP);
    expect(log.getById(ids[0]!)).toBeUndefined();
    expect(log.getById(ids[CAP + 1]!)).toBeDefined();
  });
});

describe('LLM event log bounded retention (Sprint 34)', () => {
  it('never retains more than the configured cap', () => {
    const log = new LLMEventLog({ maxStoredEvents: CAP });
    const ids: string[] = [];
    for (let i = 0; i < CAP + 2; i += 1) {
      const stored = log.append(
        startedEvent({
          provider: 'mock',
          model: 'm',
          occurredAt: T0,
          traceId: `trace-${i}`,
        }),
      );
      ids.push(stored.eventId);
    }
    expect(log.count()).toBe(CAP);
    expect(log.getById(ids[0]!)).toBeUndefined();
    expect(log.getById(ids[CAP + 1]!)).toBeDefined();
  });
});
