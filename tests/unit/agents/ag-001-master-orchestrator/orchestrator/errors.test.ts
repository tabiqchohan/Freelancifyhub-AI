import { describe, expect, it } from 'vitest';

import { TimeoutError } from '../../../../../src/agents/ag-001-master-orchestrator/errors/index.js';
import { RoutingValidationError } from '../../../../../src/agents/ag-001-master-orchestrator/routing/errors/index.js';
import {
  OrchestrationError,
  toOrchestrationError,
} from '../../../../../src/agents/ag-001-master-orchestrator/orchestrator/errors/index.js';
import { OrchestratorStage } from '../../../../../src/agents/ag-001-master-orchestrator/orchestrator/types/index.js';

describe('OrchestrationError', () => {
  it('defaults code and retryable state', () => {
    const error = new OrchestrationError('boom');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('OrchestrationError');
    expect(error.code).toBe('ORCHESTRATION_ERROR');
    expect(error.retryable).toBe(true);
  });

  it('carries stage and correlation ids', () => {
    const error = new OrchestrationError('boom', {
      stage: OrchestratorStage.Planning,
      correlation: { requestId: 'r1', traceId: 't1' },
    });
    expect(error.stage).toBe(OrchestratorStage.Planning);
    expect(error.requestId).toBe('r1');
    expect(error.traceId).toBe('t1');
    expect(error.details?.stage).toBe('PLANNING');
    expect(error.details?.requestId).toBe('r1');
  });
});

describe('toOrchestrationError', () => {
  it('preserves code and retryable flags for hierarchy errors', () => {
    const original = new TimeoutError('late');
    const wrapped = toOrchestrationError(OrchestratorStage.Execution, original, {
      requestId: 'r1',
      traceId: 't1',
    });
    expect(wrapped).toBeInstanceOf(OrchestrationError);
    expect(wrapped.code).toBe('TIMEOUT_ERROR');
    expect(wrapped.retryable).toBe(true);
    expect(wrapped.cause).toBe(original);
    expect(wrapped.stage).toBe(OrchestratorStage.Execution);
    expect(wrapped.requestId).toBe('r1');
    expect(wrapped.traceId).toBe('t1');
  });

  it('preserves routing-specific codes', () => {
    const original = new RoutingValidationError('bad route');
    const wrapped = toOrchestrationError(OrchestratorStage.Routing, original);
    expect(wrapped.code).toBe('ROUTING_VALIDATION_ERROR');
    expect(wrapped.stage).toBe(OrchestratorStage.Routing);
  });

  it('collapses unknown errors to a safe generic code', () => {
    const wrapped = toOrchestrationError(OrchestratorStage.IntentDetection, new Error('weird'));
    expect(wrapped.code).toBe('STAGE_ERROR');
    expect(wrapped.retryable).toBe(false);
    expect(wrapped.message).toContain('weird');
  });

  it('handles non-Error thrown values', () => {
    const wrapped = toOrchestrationError(OrchestratorStage.ContextBuilding, 'nope');
    expect(wrapped.code).toBe('STAGE_ERROR');
    expect(wrapped.message).toContain('nope');
  });
});
