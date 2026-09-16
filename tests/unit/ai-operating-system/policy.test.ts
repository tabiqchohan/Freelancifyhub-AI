import { describe, expect, it } from 'vitest';

import { RuleBasedIntentClassifier } from '../../../src/agents/ag-001-master-orchestrator/intent/index.js';
import { AiosErrorCode } from '../../../src/ai-operating-system/errors.js';
import { createDefaultPolicy } from '../../../src/ai-operating-system/policy.js';
import type { RequestContext } from '../../../src/ai-operating-system/request-context.js';

const policy = createDefaultPolicy();

function ctxFor(role: string, text: string, routeIntentOverride?: string): RequestContext {
  const classifier = new RuleBasedIntentClassifier();
  const intent = classifier.classify(text, { role: role as never });
  return {
    requestId: 'req-1',
    traceId: 'trace-1',
    actor: { actorId: 'u-1', role: role as never, namespaces: [] },
    input: { text },
    receivedAt: '2026-01-01T00:00:00.000Z',
    origin: 'ai-operating-system',
    intent,
    route: {
      intentId: routeIntentOverride ?? intent.primary.intent.id,
      supportedAgents: [...intent.primary.intent.supportedAgents],
      confidence: intent.confidence,
      target: { kind: 'orchestrator' },
    },
    target: { kind: 'orchestrator' },
    timeoutMs: 60_000,
    metadata: {},
  };
}

describe('AIOS authorization policy (Sprint 26)', () => {
  it('blocks admin intents for non-admin actors fail-closed', () => {
    const decision = policy.evaluate(ctxFor('Freelancer', 'hello', 'admin.analytics'));
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe(AiosErrorCode.UnauthorizedScope);
  });

  it('allows admin intents for an Admin actor', () => {
    const decision = policy.evaluate(ctxFor('Admin', 'analytics query platform trend'));
    expect(decision.allowed).toBe(true);
  });

  it('allows platform-level intents for Guests', () => {
    expect(policy.evaluate(ctxFor('Guest', 'how do i reset my password')).allowed).toBe(true);
    expect(policy.evaluate(ctxFor('Guest', 'search knowledge base faq')).allowed).toBe(true);
  });

  it('blocks non-platform intents for Guests fail-closed', () => {
    const decision = policy.evaluate(ctxFor('Guest', 'view project'));
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe(AiosErrorCode.UnauthorizedScope);
  });
});
