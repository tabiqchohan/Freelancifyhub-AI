import { describe, expect, it } from 'vitest';

import {
  RuleBasedIntentClassifier,
  type UserRole,
} from '../../../src/agents/ag-001-master-orchestrator/intent/index.js';
import { AiosErrorCode } from '../../../src/ai-operating-system/errors.js';
import {
  createRequestContext,
  deriveExecutionTarget,
  validateAiosActor,
} from '../../../src/ai-operating-system/request-context.js';

const classifier = new RuleBasedIntentClassifier();
const freelancer = 'Freelancer' as UserRole;

function classification(result: ReturnType<RuleBasedIntentClassifier['classify']>) {
  return result;
}

describe('AIOS request context (Sprint 26)', () => {
  it('derives the client team target from AG-001 registry data', () => {
    const intent = classification(
      classifier.classify('create project new website', { role: freelancer }),
    );
    expect(intent.primary.intent.id).toBe('project.create');
    expect(deriveExecutionTarget(intent)).toEqual({ kind: 'client' });
  });

  it('derives the orchestrator target for platform-level intents', () => {
    const knowledge = classification(
      classifier.classify('search knowledge base', { role: freelancer }),
    );
    expect(knowledge.primary.intent.id).toBe('knowledge.search');
    expect(deriveExecutionTarget(knowledge)).toEqual({ kind: 'orchestrator' });
  });

  it('rejects an actor envelope missing identity fail-closed', () => {
    expect(() => validateAiosActor({ actorId: '', role: freelancer, namespaces: [] })).toThrow(
      expect.objectContaining({ code: AiosErrorCode.InvalidInput }),
    );
    expect(() =>
      validateAiosActor({ actorId: 'a', role: '' as UserRole, namespaces: ['x'] }),
    ).toThrow(expect.objectContaining({ code: AiosErrorCode.InvalidInput }));
  });

  it('classifies through AG-001 and fails closed on unknown intent', () => {
    const ctx = () =>
      createRequestContext({
        requestId: 'req-1',
        traceId: 'trace-1',
        actor: { actorId: 'u-1', role: freelancer, namespaces: [] },
        input: { text: 'create project new website' },
        classifier,
        timeoutMs: 60_000,
      });
    const request = ctx();
    expect(request.route.intentId).toBe('project.create');
    expect(request.target).toEqual({ kind: 'client' });
    expect(request.origin).toBe('ai-operating-system');

    expect(() =>
      createRequestContext({
        requestId: 'req-2',
        traceId: 'trace-2',
        actor: { actorId: 'u-2', role: freelancer, namespaces: [] },
        input: { text: 'flibbertigibbet zyzzy' },
        classifier,
        timeoutMs: 60_000,
      }),
    ).toThrow(expect.objectContaining({ code: AiosErrorCode.UnknownIntent }));
  });
});
