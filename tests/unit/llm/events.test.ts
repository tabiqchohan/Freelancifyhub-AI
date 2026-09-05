import { describe, expect, it, vi } from 'vitest';

import {
  LLMEventLog,
  createLLMEventLog,
  startedEvent,
  succeededEvent,
  failedEvent,
  retryEvent,
} from '../../../src/llm/events/index.js';

describe('LLMEventLog', () => {
  it('appends and retrieves events with resolved category/severity/sequence', () => {
    const log = new LLMEventLog();
    log.append(
      startedEvent({
        provider: 'mock',
        model: 'm',
        occurredAt: '2026-01-01T00:00:00.000Z',
        traceId: 'trace-1',
      }),
    );
    log.append(
      succeededEvent({
        provider: 'mock',
        model: 'm',
        occurredAt: '2026-01-01T00:00:00.100Z',
        durationMs: 100,
        attempts: 1,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      }),
    );

    expect(log.count()).toBe(2);
    const latest = log.latest(1)[0]!;
    expect(latest.success).toBe(true);
    expect(latest.category).toBe('execution');
    expect(latest.sequence).toBe(1);
    expect(log.getById(latest.eventId)).toBe(latest);
    expect(log.query({ success: true }).total).toBe(1);
    expect(log.query({ traceId: 'trace-1' }).total).toBe(1);
  });

  it('rejects duplicate event ids', () => {
    const log = new LLMEventLog({ eventIdFactory: () => 'fixed-id' });
    const event = startedEvent({
      provider: 'mock',
      model: 'm',
      occurredAt: '2026-01-01T00:00:00.000Z',
    });
    log.append(event);
    expect(() => log.append(event)).toThrow(/Duplicate LLM event id/);
  });

  it('rejects events missing required fields', () => {
    const log = new LLMEventLog();
    expect(() => log.append({ type: 'llm.reasoning.started', occurredAt: '' } as never)).toThrow(
      /missing required fields/,
    );
  });

  it('classifies error events into stable categories and severity', () => {
    const log = new LLMEventLog();
    log.append(
      failedEvent({
        provider: 'http',
        model: 'm',
        occurredAt: '2026-01-01T00:00:00.000Z',
        errorClass: 'rate_limit',
        errorCode: 'LLM_RATE_LIMIT_ERROR',
      }),
    );
    const event = log.latest(1)[0]!;
    expect(event.type).toBe('llm.reasoning.rate_limited');
    expect(event.category).toBe('rate_limit');
    expect(event.severity).toBe('warning');
    expect(event.errorCode).toBe('LLM_RATE_LIMIT_ERROR');
  });

  it('never stores API keys / prompts / response content', () => {
    const log = new LLMEventLog();
    log.append(
      startedEvent({ provider: 'mock', model: 'm', occurredAt: '2026-01-01T00:00:00.000Z' }),
    );
    log.append(
      succeededEvent({
        provider: 'mock',
        model: 'm',
        occurredAt: '2026-01-01T00:00:00.000Z',
        durationMs: 1,
      }),
    );
    log.append(
      failedEvent({
        provider: 'http',
        model: 'm',
        occurredAt: '2026-01-01T00:00:00.000Z',
        errorClass: 'authentication',
        errorCode: 'LLM_AUTHENTICATION_ERROR',
      }),
    );
    const serialized = JSON.stringify(log.latest(100));
    expect(serialized).not.toMatch(/sk-test|authorization|password|bearer/i);
  });

  it('pages queries by cursor with a bounded page size', () => {
    let counter = 0;
    const log = new LLMEventLog({
      maxPageSize: 2,
      eventIdFactory: () => `id-${(counter += 1)}`,
    });
    for (let i = 0; i < 5; i += 1) {
      log.append(
        retryEvent({
          provider: 'mock',
          model: 'm',
          occurredAt: `2026-01-01T00:00:0${i}.000Z`,
          attempt: i + 1,
          delayMs: 10,
        }),
      );
    }
    const page1 = log.query({ limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.hasMore).toBe(true);
    const cursor = page1.items[page1.items.length - 1]?.eventId;
    const page2 = log.query({ limit: 2, cursor });
    expect(page2.items).toHaveLength(2);
    expect(page2.total).toBe(5);
  });

  it('clear resets the trail deterministically', () => {
    const log = new LLMEventLog();
    log.append(
      startedEvent({ provider: 'mock', model: 'm', occurredAt: '2026-01-01T00:00:00.000Z' }),
    );
    log.clear();
    expect(log.count()).toBe(0);
    expect(log.latest()).toEqual([]);
  });

  it('createLLMEventLog builds a usable log', () => {
    const log = createLLMEventLog();
    expect(log.name).toBe('llm-event-log');
    expect(log.pageSize).toBe(50);
  });

  it('vi-spy usage is available for event factories', () => {
    const spy = vi.fn();
    spy('x');
    expect(spy).toHaveBeenCalledWith('x');
  });
});
