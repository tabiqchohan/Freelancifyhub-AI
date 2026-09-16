import { describe, expect, it } from 'vitest';

import { AiosEventLog } from '../../../src/ai-operating-system/events.js';
import { AiosStage } from '../../../src/ai-operating-system/types.js';

describe('AIOS event system of record (Sprint 26)', () => {
  it('records lifecycle events newest-first per request and bounds the ring', () => {
    const log = new AiosEventLog({ window: 3 });
    for (let i = 0; i < 5; i += 1) {
      log.emitFor('req-1', 'trace-1', `stage.${i}`, AiosStage.Completed);
    }
    const events = log.eventsFor('req-1');
    expect(events).toHaveLength(3);
    expect(events[0]?.type).toBe('stage.4');
    expect(log.snapshot()).toHaveLength(3);
  });

  it('forwards typed events to the runtime bridge through onForward', () => {
    const forwarded: string[] = [];
    const log = new AiosEventLog({ onForward: (event) => forwarded.push(event.type) });
    log.emitFor('req-1', 'trace-1', 'request.failed', AiosStage.Failed);
    log.emitFor('req-2', 'trace-2', 'stage.completed', AiosStage.Execute);
    expect(forwarded.length).toBe(2);
    expect(forwarded[0]).toBe('AGENT_EXECUTION_FAILED');
  });

  it('injects a probe event without affecting request logic', () => {
    const log = new AiosEventLog();
    log.injectProbe('req-1', 'trace-1', '#112233');
    const probe = log.probeFor('req-1');
    expect(probe).toBeDefined();
    expect(probe?.type).toBe('aios.probe');
    expect(probe?.metadata).toMatchObject({ favoriteColor: '#112233', aiosProbe: true });
  });

  it('counts events by type with optional prefix grouping', () => {
    const log = new AiosEventLog();
    log.emitFor('req-1', 'trace-1', 'stage.completed', AiosStage.Plan);
    log.emitFor('req-1', 'trace-1', 'stage.completed', AiosStage.Execute);
    log.emitFor('req-1', 'trace-1', 'request.succeeded', AiosStage.Completed);
    expect(log.recordCounts()).toEqual({ 'stage.completed': 2, 'request.succeeded': 1 });
    expect(log.recordCounts('stage.')).toEqual({ 'stage.': 2, 'request.succeeded': 1 });
  });
});
