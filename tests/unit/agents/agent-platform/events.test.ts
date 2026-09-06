import { describe, expect, it } from 'vitest';

import {
  AgentPlatformEventLog,
  createAgentPlatformEventLog,
  executionDeniedEvent,
  platformCategoryForType,
  platformSeverityForType,
} from '../../../../src/agents/agent-platform/events.js';

describe('AgentPlatformEventLog', () => {
  it('appends events with deterministic sequence and ids', () => {
    const log = createAgentPlatformEventLog({ eventIdFactory: () => 'apv_test' });
    const event = executionDeniedEvent({
      occurredAt: '2026-09-06T00:00:00.000Z',
      reasonCode: 'AGENT_NOT_READY',
    });
    const stored = log.append(event);
    expect(stored.eventId).toBe('apv_test');
    expect(stored.sequence).toBe(0);
    expect(stored.category).toBe('policy');
    expect(stored.severity).toBe('warning');
  });

  it('rejects duplicate event ids', () => {
    const log = createAgentPlatformEventLog({ eventIdFactory: () => 'apv_same' });
    log.append(executionDeniedEvent({ occurredAt: '2026-09-06T00:00:00.000Z' }));
    expect(() =>
      log.append(executionDeniedEvent({ occurredAt: '2026-09-06T00:00:00.001Z' })),
    ).toThrow(/Duplicate agent platform event id/);
  });

  it('queries by agent id and type', () => {
    const log = new AgentPlatformEventLog();
    log.append(executionDeniedEvent({ occurredAt: '2026-09-06T00:00:00.000Z', agentId: 'AG-101' }));
    log.append(executionDeniedEvent({ occurredAt: '2026-09-06T00:00:00.000Z', agentId: 'AG-102' }));
    log.append(executionDeniedEvent({ occurredAt: '2026-09-06T00:00:00.000Z', agentId: 'AG-101' }));
    expect(log.count({ agentId: 'AG-101' })).toBe(2);
    expect(log.query({ agentId: 'AG-101', limit: 10 }).items).toHaveLength(2);
    expect(log.query({ agentId: 'AG-102' }).total).toBe(1);
  });

  it('paginates with a cursor and caps the page size', () => {
    const log = new AgentPlatformEventLog({ maxPageSize: 2 });
    for (let i = 0; i < 5; i += 1) {
      log.append(executionDeniedEvent({ occurredAt: `2026-09-06T00:00:0${i}.000Z` }));
    }
    const page = log.query({ limit: 10 });
    expect(page.items).toHaveLength(2);
    expect(page.total).toBe(5);
    expect(page.hasMore).toBe(true);
  });

  it('latest returns most recent first and is bounded', () => {
    const log = new AgentPlatformEventLog({ maxPageSize: 2 });
    log.append(executionDeniedEvent({ occurredAt: '2026-09-06T00:00:00.000Z' }));
    log.append(executionDeniedEvent({ occurredAt: '2026-09-06T00:00:01.000Z' }));
    const latest = log.latest(1);
    expect(latest).toHaveLength(1);
  });

  it('clear resets all state', () => {
    const log = createAgentPlatformEventLog();
    log.append(executionDeniedEvent({ occurredAt: '2026-09-06T00:00:00.000Z' }));
    log.clear();
    expect(log.count()).toBe(0);
    expect(log.count({ agentId: 'AG-101' })).toBe(0);
  });
});

describe('platform event classification', () => {
  it('classifies types into categories', () => {
    expect(platformCategoryForType('agent.registered')).toBe('lifecycle');
    expect(platformCategoryForType('agent.execution.denied')).toBe('policy');
    expect(platformCategoryForType('agent.tool.denied')).toBe('policy');
  });

  it('classifies severities', () => {
    expect(platformSeverityForType('agent.ready')).toBe('info');
    expect(platformSeverityForType('agent.failed')).toBe('error');
    expect(platformSeverityForType('agent.disabled')).toBe('warning');
    expect(platformSeverityForType('agent.permission.denied')).toBe('error');
  });
});
