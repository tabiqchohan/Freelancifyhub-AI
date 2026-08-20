import { describe, expect, it } from 'vitest';

import {
  InMemoryMemoryEventEmitter,
  MemoryEventType,
} from '../../../../src/agents/ag-002-memory-manager/events/index.js';

describe('InMemoryMemoryEventEmitter - deterministic event sink (spec §16)', () => {
  it('records emitted events in order', () => {
    const emitter = new InMemoryMemoryEventEmitter();
    emitter.emit({
      type: MemoryEventType.Created,
      traceId: 'trace_1',
      occurredAt: '2026-01-01T00:00:00.000Z',
      namespace: 'user:1',
      key: 'theme',
      version: 1,
    });
    emitter.emit({
      type: MemoryEventType.Updated,
      traceId: 'trace_1',
      occurredAt: '2026-01-01T00:00:01.000Z',
      namespace: 'user:1',
      key: 'theme',
      version: 2,
      previousVersion: 1,
    });
    expect(emitter.list().map((e) => e.type)).toEqual([
      MemoryEventType.Created,
      MemoryEventType.Updated,
    ]);
  });

  it('notifies subscribers and supports unsubscribing', () => {
    const emitter = new InMemoryMemoryEventEmitter();
    const seen: string[] = [];
    const off = emitter.on((event) => seen.push(event.type));
    emitter.emit({
      type: MemoryEventType.Archived,
      traceId: 't',
      occurredAt: '2026-01-01T00:00:00.000Z',
      namespace: 'user:1',
      key: 'k',
    });
    off();
    emitter.emit({
      type: MemoryEventType.Deleted,
      traceId: 't',
      occurredAt: '2026-01-01T00:00:01.000Z',
      namespace: 'user:1',
      key: 'k',
      hard: true,
    });
    expect(seen).toEqual([MemoryEventType.Archived]);
  });

  it('carries the memory lifecycle event payload highlights (spec §16)', () => {
    const emitter = new InMemoryMemoryEventEmitter();
    emitter.emit({
      type: MemoryEventType.Deleted,
      traceId: 'trace_9',
      occurredAt: '2026-01-01T00:00:00.000Z',
      namespace: 'user:1',
      key: 'k',
      hard: true,
      reason: 'DSR erasure',
    });
    const event = emitter.list()[0];
    expect(event).toMatchObject({
      type: MemoryEventType.Deleted,
      key: 'k',
      hard: true,
      reason: 'DSR erasure',
      traceId: 'trace_9',
    });
  });

  it('clears recorded events', () => {
    const emitter = new InMemoryMemoryEventEmitter();
    emitter.emit({
      type: MemoryEventType.Retrieved,
      traceId: 't',
      occurredAt: '2026-01-01T00:00:00.000Z',
      namespace: 'user:1',
      key: 'k',
      count: 3,
    });
    emitter.clear();
    expect(emitter.list()).toEqual([]);
  });
});
