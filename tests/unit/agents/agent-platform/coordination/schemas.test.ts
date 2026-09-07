import { describe, expect, it } from 'vitest';

import {
  CoordinationPlanInvalidError,
  CoordinationMessageValidationError,
} from '../../../../../src/agents/agent-platform/coordination/errors.js';
import {
  assertMessageSize,
  parseCoordinationRequest,
  parseCoordinationTaskInput,
  parseCoordinationMessage,
  parseTaskResult,
} from '../../../../../src/agents/agent-platform/coordination/schemas.js';
import {
  AggregationStrategy,
  ConflictPolicy,
  CoordinationMode,
  TaskFailurePolicy,
  TaskStatus,
} from '../../../../../src/agents/agent-platform/coordination/types.js';
import { COORDINATION_DEFAULT_RETRY } from '../../../../../src/agents/agent-platform/coordination/constants.js';

describe('coordination schemas (Sprint 20 validation)', () => {
  it('validates a coordination request with pre-built tasks', () => {
    const parsed = parseCoordinationRequest({
      coordinationId: 'coord_1',
      correlationId: 'corr-1',
      requester: 'AG-001',
      objective: 'deliver a milestone',
      mode: CoordinationMode.Sequential,
      tasks: [{ taskId: 't1', agentId: 'AG-200', objective: 'step one' }],
      failurePolicy: TaskFailurePolicy.ContinueIndependent,
      conflictPolicy: ConflictPolicy.AllResults,
      aggregation: AggregationStrategy.Collect,
    });
    expect(parsed.coordinationId).toBe('coord_1');
  });

  it('rejects a request with neither tasks nor participants', () => {
    expect(() =>
      parseCoordinationRequest({
        correlationId: 'corr-1',
        requester: 'AG-001',
        objective: 'nothing',
        mode: CoordinationMode.Single,
      }),
    ).toThrow(CoordinationPlanInvalidError);
  });

  it('rejects unknown fields and invalid modes', () => {
    expect(() =>
      parseCoordinationRequest({
        correlationId: 'corr-1',
        requester: 'AG-001',
        objective: 'x',
        mode: 'SOMETHING_ELSE',
        tasks: [{ taskId: 't1', agentId: 'AG-200', objective: 'y' }],
      }),
    ).toThrow(CoordinationPlanInvalidError);
    expect(() =>
      parseCoordinationRequest({
        correlationId: 'corr-1',
        requester: 'AG-001',
        objective: 'x',
        mode: CoordinationMode.Single,
        tasks: [{ taskId: 't1', agentId: 'AG-200', objective: 'y' }],
        extra: true,
      }),
    ).toThrow(CoordinationPlanInvalidError);
  });

  it('passes an AbortSignal as transient (never schema data)', () => {
    const controller = new AbortController();
    const parsed = parseCoordinationRequest({
      correlationId: 'corr-1',
      requester: 'AG-001',
      objective: 'x',
      mode: CoordinationMode.Single,
      tasks: [{ taskId: 't1', agentId: 'AG-200', objective: 'y' }],
      cancellation: controller.signal,
    });
    expect(parsed.cancellation).toBe(controller.signal);
  });

  it('normalizes a task input with server defaults', () => {
    const parsed = parseCoordinationTaskInput({
      taskId: 't1',
      agentId: 'AG-200',
      objective: 'step',
    });
    expect(parsed.dependencies).toEqual([]);
    expect(parsed.requiredCapabilities).toEqual([]);
    expect(parsed.requiredTools).toEqual([]);
    expect(parsed.priority).toBe(0);
    expect(parsed.retry).toEqual(COORDINATION_DEFAULT_RETRY);
    expect(parsed.metadata).toBeUndefined();
  });

  it('rejects invalid task ids and oversize dependencies', () => {
    expect(() =>
      parseCoordinationTaskInput({ taskId: '-bad', agentId: 'AG-200', objective: 'step' }),
    ).toThrow(CoordinationPlanInvalidError);
    expect(() =>
      parseCoordinationTaskInput({
        taskId: 't1',
        agentId: 'AG-200',
        objective: 'step',
        dependencies: Array.from({ length: 17 }, (_, i) => `t${i}`),
      }),
    ).toThrow(CoordinationPlanInvalidError);
  });

  it('validates coordination messages', () => {
    const parsed = parseCoordinationMessage({
      messageId: 'm1',
      coordinationId: 'coord_1',
      sender: 'AG-200',
      recipient: 'AG-201',
      messageType: 'proposal',
      payload: { body: 'hi' } as Record<string, unknown>,
      occurredAt: '2026-01-01T00:00:00.000Z',
      schemaVersion: '1',
    }) as { sender: string; payload: { body?: string } };
    expect(parsed.sender).toBe('AG-200');
    expect(parsed.payload.body).toBe('hi');
  });

  it('rejects a message with an invalid coordination id', () => {
    expect(() =>
      parseCoordinationMessage({
        messageId: 'm1',
        coordinationId: 'Not Valid!',
        sender: 'AG-200',
        recipient: 'AG-201',
        messageType: 'proposal',
        payload: {},
        occurredAt: '2026-01-01T00:00:00.000Z',
        schemaVersion: '1',
      }),
    ).toThrow(CoordinationMessageValidationError);
  });

  it('asserts payload size against the byte cap', () => {
    expect(() => assertMessageSize('x'.repeat(100), 1024)).not.toThrow();
    expect(() => assertMessageSize({ data: 'y'.repeat(5000) }, 1024)).toThrow(
      CoordinationMessageValidationError,
    );
  });

  it('parses validated task results', () => {
    const parsed = parseTaskResult({
      taskId: 't1',
      agentId: 'AG-200',
      status: TaskStatus.Completed,
      output: { ok: true },
      timing: { durationMs: 5 },
    });
    expect(parsed.errors).toEqual([]);
    expect(parsed.status).toBe(TaskStatus.Completed);
  });
});
