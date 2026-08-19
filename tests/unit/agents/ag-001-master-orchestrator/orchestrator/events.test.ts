import { describe, expect, it } from 'vitest';

import {
  InMemoryOrchestratorEventEmitter,
  OrchestratorEventType,
} from '../../../../../src/agents/ag-001-master-orchestrator/orchestrator/services/events.js';
import { OrchestratorStage } from '../../../../../src/agents/ag-001-master-orchestrator/orchestrator/types/index.js';

describe('InMemoryOrchestratorEventEmitter', () => {
  it('records emitted events with correlation fields', () => {
    const emitter = new InMemoryOrchestratorEventEmitter();
    emitter.emit({
      type: OrchestratorEventType.OrchestrationStarted,
      requestId: 'r1',
      traceId: 't1',
      occurredAt: '2026-01-01T00:00:00.000Z',
      stage: OrchestratorStage.Validation,
    });
    const events = emitter.list();
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe(OrchestratorEventType.OrchestrationStarted);
    expect(events[0]?.requestId).toBe('r1');
    expect(events[0]?.traceId).toBe('t1');
  });

  it('notifies handlers and returns an unsubscribe function', () => {
    const emitter = new InMemoryOrchestratorEventEmitter();
    const seen: string[] = [];
    const unsubscribe = emitter.on((event) => seen.push(event.type));

    emitter.emit({
      type: OrchestratorEventType.IntentDetected,
      requestId: 'r',
      traceId: 't',
      occurredAt: 'x',
    });
    unsubscribe();
    emitter.emit({
      type: OrchestratorEventType.ContextBuilt,
      requestId: 'r',
      traceId: 't',
      occurredAt: 'x',
    });

    expect(seen).toEqual([OrchestratorEventType.IntentDetected]);
  });

  it('clear empties the recorded history without affecting handlers', () => {
    const emitter = new InMemoryOrchestratorEventEmitter();
    emitter.emit({
      type: OrchestratorEventType.ContextBuilt,
      requestId: 'r',
      traceId: 't',
      occurredAt: 'x',
    });
    emitter.clear();
    expect(emitter.list()).toHaveLength(0);
    emitter.emit({
      type: OrchestratorEventType.ContextBuilt,
      requestId: 'r',
      traceId: 't',
      occurredAt: 'x',
    });
    expect(emitter.list()).toHaveLength(1);
  });
});
