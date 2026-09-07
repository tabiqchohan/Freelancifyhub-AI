import { describe, expect, it } from 'vitest';

import { CoordinationMessageBus } from '../../../../../src/agents/agent-platform/coordination/messages.js';
import { CoordinationMessageValidationError } from '../../../../../src/agents/agent-platform/coordination/errors.js';
import type {
  AgentTask,
  CoordinationMessage,
} from '../../../../../src/agents/agent-platform/coordination/types.js';
import { TaskStatus } from '../../../../../src/agents/agent-platform/coordination/types.js';

function participant(agentId: string): AgentTask {
  return {
    taskId: `task-${agentId}`,
    agentId,
    coordinationId: 'coord_1',
    objective: 'participation',
    input: {},
    dependencies: [],
    requiredCapabilities: [],
    requiredTools: [],
    priority: 0,
    timeoutMs: 5000,
    retry: { maxRetries: 0, retryable: false, backoffMs: 0, backoffMultiplier: 1, maxBackoffMs: 0 },
    status: TaskStatus.Pending,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function message(
  sender: string,
  recipient: string,
  overrides: Partial<CoordinationMessage> = {},
): CoordinationMessage {
  return {
    messageId: `m-${sender}-${recipient}`,
    coordinationId: 'coord_1',
    sender,
    recipient,
    messageType: 'proposal',
    payload: { body: 'hi' },
    occurredAt: '2026-01-01T00:00:00.000Z',
    schemaVersion: '1',
    ...overrides,
  };
}

describe('CoordinationMessageBus (Sprint 20 §10)', () => {
  it('stores a message between participating agents', () => {
    const bus = new CoordinationMessageBus();
    const stored = bus.send(
      message('AG-200', 'AG-201'),
      [participant('AG-200'), participant('AG-201')],
      'AG-200',
    );
    expect(stored.messageId).toBe('m-AG-200-AG-201');
    expect(bus.count('coord_1')).toBe(1);
  });

  it('rejects a non-participant sender', () => {
    const bus = new CoordinationMessageBus();
    expect(() =>
      bus.send(message('AG-999', 'AG-201'), [participant('AG-200'), participant('AG-201')]),
    ).toThrow(CoordinationMessageValidationError);
  });

  it('rejects a non-participant recipient', () => {
    const bus = new CoordinationMessageBus();
    expect(() =>
      bus.send(message('AG-200', 'AG-999'), [participant('AG-200'), participant('AG-201')]),
    ).toThrow(CoordinationMessageValidationError);
  });

  it('rejects sending as another agent', () => {
    const bus = new CoordinationMessageBus();
    expect(() =>
      bus.send(
        message('AG-200', 'AG-201'),
        [participant('AG-200'), participant('AG-201')],
        'AG-201',
      ),
    ).toThrow(CoordinationMessageValidationError);
  });

  it('enforces the byte cap on payloads', () => {
    const bus = new CoordinationMessageBus({ maxMessageBytes: 64 });
    expect(() =>
      bus.send(message('AG-200', 'AG-201', { payload: { blob: 'x'.repeat(200) } }), [
        participant('AG-200'),
        participant('AG-201'),
      ]),
    ).toThrow(CoordinationMessageValidationError);
  });

  it('enforces the per-coordination message limit', () => {
    const bus = new CoordinationMessageBus({ maxMessagesPerCoordination: 1 });
    bus.send(message('AG-200', 'AG-201'), [participant('AG-200'), participant('AG-201')]);
    expect(() =>
      bus.send(message('AG-200', 'AG-201', { messageId: 'm2' }), [
        participant('AG-200'),
        participant('AG-201'),
      ]),
    ).toThrow(CoordinationMessageValidationError);
  });

  it('scopes reads to messages the reader may see', () => {
    const bus = new CoordinationMessageBus();
    const participants = [participant('AG-200'), participant('AG-201'), participant('AG-202')];
    bus.send(message('AG-200', 'AG-201'), participants);
    bus.send(message('AG-202', '*'), participants);
    const visible = bus.read('coord_1', 'AG-201', participants);
    expect(visible.map((m) => m.messageId).sort()).toEqual(
      ['m-AG-200-AG-201', 'm-AG-202-*'].sort(),
    );
    const own = bus.read('coord_1', 'AG-200', participants, 1);
    expect(own.length).toBe(1);
  });

  it('rejects reads from a non-participant', () => {
    const bus = new CoordinationMessageBus();
    expect(() => bus.read('coord_1', 'AG-999', [participant('AG-200')])).toThrow(
      CoordinationMessageValidationError,
    );
  });
});
