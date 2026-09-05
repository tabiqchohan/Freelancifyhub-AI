import { describe, expect, it } from 'vitest';

import {
  ToolEventLog,
  createToolEventLog,
  ToolEventType,
  ToolActorGroup,
} from '../../../../src/agents/ag-004-tool-manager/index.js';
import {
  ToolEventError,
  ToolConflictError,
} from '../../../../src/agents/ag-004-tool-manager/errors/index.js';

function baseEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: ToolEventType.ExecutionSucceeded,
    traceId: 'trace-1',
    occurredAt: new Date().toISOString(),
    namespace: 'default',
    toolId: 'tool:x:v1.0.0',
    toolName: 'x',
    toolVersion: '1.0.0',
    executionId: 'texec_1',
    actorGroup: ToolActorGroup.Orchestrator,
    actorId: 'o-1',
    ...overrides,
  } as never;
}

describe('AG-004 Tool Event Log', () => {
  it('appends an event deriving default severity/category/source', () => {
    const log = new ToolEventLog();
    const stored = log.append(baseEvent());
    expect(stored.eventId).toMatch(/^tev_/);
    expect(stored.sequence).toBe(0);
    expect(stored.severity).toBe('info');
    expect(stored.category).toBe('execution');
    expect(stored.source).toBe('execution');
  });

  it('rejects events missing required fields (fail closed)', () => {
    const log = new ToolEventLog();
    expect(() => log.append({ type: ToolEventType.ExecutionStarted } as never)).toThrow(
      ToolEventError,
    );
  });

  it('rejects duplicate event ids', () => {
    const log = new ToolEventLog();
    log.append(baseEvent({ eventId: 'ev-1' }));
    const second = baseEvent({ eventId: 'ev-1', executionId: 'texec_2' });
    expect(() => log.append(second)).toThrow(ToolConflictError);
  });

  it('filters by type, toolId, namespace, and executionId', () => {
    const log = new ToolEventLog();
    log.append(baseEvent({ eventId: 'a', executionId: 'texec_1' }));
    log.append(
      baseEvent({
        eventId: 'b',
        type: ToolEventType.ExecutionFailed,
        executionId: 'texec_2',
        errorCode: 'X',
      }),
    );

    expect(log.count()).toBe(2);
    expect(log.count({ type: ToolEventType.ExecutionFailed })).toBe(1);
    expect(log.count({ toolId: 'tool:x:v1.0.0' })).toBe(2);
    expect(log.count({ executionId: 'texec_1' })).toBe(1);
  });

  it('paginates and supports cursor queries', () => {
    const log = new ToolEventLog();
    for (let i = 0; i < 5; i++) {
      log.append(baseEvent({ eventId: `e${i}`, executionId: `texec_${i}` }));
    }
    const page = log.query({ type: ToolEventType.ExecutionSucceeded, limit: 2 });
    expect(page.total).toBe(5);
    expect(page.items.length).toBe(2);
    expect(page.hasMore).toBe(true);

    const next = log.query({
      type: ToolEventType.ExecutionSucceeded,
      limit: 10,
      cursor: page.items[1]?.eventId,
    });
    expect(next.items.length).toBe(3);
  });

  it('latest returns newest events first', () => {
    const log = createToolEventLog();
    log.append(baseEvent({ eventId: 'e0' }));
    log.append(baseEvent({ eventId: 'e1' }));
    const latest = log.latest(2);
    expect(latest[0]?.eventId).toBe('e1');
  });

  it('caps page size at the configured maximum', () => {
    const log = new ToolEventLog({ maxPageSize: 3 });
    for (let i = 0; i < 10; i++) {
      log.append(baseEvent({ eventId: `e${i}` }));
    }
    expect(log.query({ limit: 100 }).items.length).toBe(3);
    expect(log.latest(100).length).toBe(3);
  });
});
