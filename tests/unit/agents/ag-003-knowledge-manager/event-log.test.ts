import { describe, expect, it } from 'vitest';

import { createKnowledgeEventLog } from '../../../../src/agents/ag-003-knowledge-manager/events/log.js';
import { KnowledgeActorGroup } from '../../../../src/agents/ag-003-knowledge-manager/enums/index.js';
import { KnowledgeAuditEventType } from '../../../../src/agents/ag-003-knowledge-manager/events/index.js';
import { createTraceId } from '../../../../src/agents/ag-003-knowledge-manager/utils/ids.js';

describe('AG-003 event log - append-only semantics', () => {
  const baseEvent = {
    eventId: 'kvev_1',
    type: KnowledgeAuditEventType.Created,
    namespace: 'user:1',
    knowledgeId: 'knowledge_1',
    actorGroup: KnowledgeActorGroup.KnowledgeManager,
    actorId: 'km-1',
    severity: 'info' as const,
    occurredAt: '2026-01-01T00:00:00.000Z',
    traceId: createTraceId(),
  };

  it('is append-only', () => {
    const log = createKnowledgeEventLog();
    log.append(baseEvent);
    expect(() => log.append({ ...baseEvent, eventId: 'kvev_1' })).toThrow(/duplicate/i);
  });

  it('counts events', () => {
    const log = createKnowledgeEventLog();
    expect(log.count()).toBe(0);
    log.append(baseEvent);
    expect(log.count()).toBe(1);
  });

  it('queries by knowledgeId', () => {
    const log = createKnowledgeEventLog();
    log.append(baseEvent);
    const events = log.query({ knowledgeId: 'knowledge_1' });
    expect(events.items.length).toBe(1);
  });

  it('queries by namespace', () => {
    const log = createKnowledgeEventLog();
    log.append(baseEvent);
    const events = log.query({ namespace: 'user:1' });
    expect(events.items.length).toBe(1);
  });

  it('queries by type', () => {
    const log = createKnowledgeEventLog();
    log.append(baseEvent);
    const events = log.query({ type: KnowledgeAuditEventType.Created });
    expect(events.items.length).toBe(1);
  });

  it('throws on missing required fields', () => {
    const log = createKnowledgeEventLog();
    expect(() =>
      log.append({
        ...baseEvent,
        // @ts-expect-error - intentionally missing traceId
        traceId: undefined,
      }),
    ).toThrow(/required/i);
  });

  it('supports cursor pagination', () => {
    const log = createKnowledgeEventLog();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const e = log.append({ ...baseEvent, eventId: `kvev_${i + 1}` });
      ids.push(e.eventId);
    }
    const page = log.query({ limit: 2 });
    expect(page.items.length).toBe(2);
    expect(page.total).toBe(5);
    expect(page.hasMore).toBe(true);
  });
});
