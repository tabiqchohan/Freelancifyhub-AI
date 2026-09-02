import { describe, expect, it } from 'vitest';

import {
  RuntimeEventBridge,
  createRuntimeEventBridge,
} from '../../../src/app/runtime-event-bridge.js';
import { RuntimeAgentEventType } from '../../../src/agents/runtime/types.js';
import type { RuntimeAgentEvent } from '../../../src/agents/runtime/types.js';
import { InMemoryEventLog } from '../../../src/agents/ag-002-memory-manager/events/index.js';
import { MemoryEventType } from '../../../src/agents/ag-002-memory-manager/events/index.js';

function runtimeEvent(overrides: Partial<RuntimeAgentEvent> = {}): RuntimeAgentEvent {
  return {
    type: RuntimeAgentEventType.ExecutionCompleted,
    traceId: 'trace-1',
    occurredAt: '2026-01-01T00:00:00.000Z',
    executionId: 'exec_req-1',
    requestId: 'req-1',
    stepId: 'step-1',
    agentId: 'AG-101',
    metadata: { success: true, orchestrationStage: 'execute' },
    ...overrides,
  };
}

describe('RuntimeEventBridge (Phase 6)', () => {
  it('appends a runtime event to the canonical AG-002 log', () => {
    const log = new InMemoryEventLog();
    const bridge = new RuntimeEventBridge({ log });
    bridge.accept(runtimeEvent());
    const events = log.latest();
    expect(events.length).toBe(1);
    expect(events[0]?.type).toBe(MemoryEventType.Retrieved);
    expect(events[0]?.traceId).toBe('trace-1');
    expect((events[0]?.metadata as Record<string, string>)?.['runtimeEventType']).toBe(
      RuntimeAgentEventType.ExecutionCompleted,
    );
    expect(events[0]?.requestId).toBe('req-1');
  });

  it('maps an execution failure to a warning AccessDenied event', () => {
    const log = new InMemoryEventLog();
    const bridge = new RuntimeEventBridge({ log });
    bridge.accept(runtimeEvent({ type: RuntimeAgentEventType.ExecutionFailed }));
    const events = log.latest();
    expect(events[0]?.type).toBe(MemoryEventType.AccessDenied);
    expect(events[0]?.severity).toBe('warning');
  });

  it('maps a start to an Activated info event', () => {
    const log = new InMemoryEventLog();
    const bridge = new RuntimeEventBridge({ log });
    bridge.accept(runtimeEvent({ type: RuntimeAgentEventType.ExecutionStarted }));
    const events = log.latest();
    expect(events[0]?.type).toBe(MemoryEventType.Activated);
    expect(events[0]?.severity).toBe('info');
  });

  it('exposes its canonical log via the eventLog getter', () => {
    const log = new InMemoryEventLog();
    const bridge = new RuntimeEventBridge({ log });
    expect(bridge.eventLog).toBe(log);
  });

  it('creates a fresh log when none is supplied', () => {
    const bridge = createRuntimeEventBridge();
    bridge.accept(runtimeEvent());
    expect(bridge.eventLog.latest().length).toBe(1);
  });
});
