import { describe, expect, it } from 'vitest';

import { ValidationError } from '../../../../../src/agents/ag-001-master-orchestrator/errors/index.js';
import { UserRole } from '../../../../../src/agents/ag-001-master-orchestrator/intent/index.js';
import {
  normalizeOrchestrationRequest,
  validateOrchestrationRequest,
} from '../../../../../src/agents/ag-001-master-orchestrator/orchestrator/validators/index.js';

describe('validateOrchestrationRequest', () => {
  it('rejects non-object input', () => {
    expect(() => validateOrchestrationRequest(null)).toThrow(ValidationError);
    expect(() => validateOrchestrationRequest('nope')).toThrow(ValidationError);
    expect(() => validateOrchestrationRequest([1, 2])).toThrow(ValidationError);
  });

  it('rejects missing, empty or non-string text', () => {
    expect(() => validateOrchestrationRequest({ role: UserRole.Freelancer })).toThrow(
      ValidationError,
    );
    expect(() => validateOrchestrationRequest({ text: '', role: UserRole.Freelancer })).toThrow(
      ValidationError,
    );
    expect(() => validateOrchestrationRequest({ text: '   ', role: UserRole.Freelancer })).toThrow(
      ValidationError,
    );
    expect(() => validateOrchestrationRequest({ text: 42, role: UserRole.Freelancer })).toThrow(
      ValidationError,
    );
  });

  it('rejects an invalid role', () => {
    expect(() => validateOrchestrationRequest({ text: 'x', role: 'ROLE_NOPE' })).toThrow(
      ValidationError,
    );
  });

  it('accepts a valid request and preserves supplied identifiers', () => {
    const input = {
      text: 'create project',
      role: UserRole.Freelancer,
      requestId: 'req-1',
      traceId: 'trace-1',
    };
    expect(validateOrchestrationRequest(input)).toEqual(input);
  });
});

describe('normalizeOrchestrationRequest', () => {
  it('fills missing correlation identifiers deterministically', () => {
    const normalized = normalizeOrchestrationRequest({
      text: 'create project',
      role: UserRole.Freelancer,
    });
    expect(normalized.requestId).toBeTruthy();
    expect(normalized.traceId).toBeTruthy();
    expect(normalized.text).toBe('create project');
    expect(normalized.role).toBe(UserRole.Freelancer);
  });

  it('keeps caller-supplied identifiers', () => {
    const normalized = normalizeOrchestrationRequest({
      text: 'x',
      role: UserRole.Admin,
      requestId: 'req-k',
      traceId: 'trace-k',
    });
    expect(normalized.requestId).toBe('req-k');
    expect(normalized.traceId).toBe('trace-k');
  });

  it('never mutates the caller object', () => {
    const input = Object.freeze({ text: 'create project', role: UserRole.Freelancer });
    normalizeOrchestrationRequest(input);
    expect((input as { requestId?: string }).requestId).toBeUndefined();
  });

  it('passes optional constraints through untouched', () => {
    const normalized = normalizeOrchestrationRequest({
      text: 'x',
      role: UserRole.Freelancer,
      origin: 'test',
      routingConstraints: { excludedAgents: ['AG-999'] },
      budget: { maxTokens: 1000 },
    });
    expect(normalized.origin).toBe('test');
    expect(normalized.routingConstraints?.excludedAgents).toEqual(['AG-999']);
    expect(normalized.budget?.maxTokens).toBe(1000);
  });
});
