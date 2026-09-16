import { describe, expect, it } from 'vitest';

import { ClientWorkflowRegistry } from '../../../../src/agents/client-ai-team/index.js';
import { CLIENT_PROJECT_CREATION_WORKFLOW } from '../../../../src/agents/client-ai-team/index.js';
import type { AgentSelector } from '../../../../src/agents/agent-platform/coordination/index.js';
import type { ClientContext, ClientRequest } from '../../../../src/agents/client-ai-team/index.js';

const stubSelector = {
  name: 'stub-selector',
  select: async () => undefined,
} as unknown as AgentSelector;

function request(metadata: Readonly<Record<string, unknown>>): ClientRequest {
  return {
    clientRequestId: 'req-1',
    correlationId: 'corr-1',
    requestId: 'req-1',
    traceId: 'trace-1',
    intent: 'project.create',
    input: { brief: 'new website' },
    actor: { actorId: 'user-1', namespaces: ['community'], role: 'Freelancer' },
    metadata,
  } as ClientRequest;
}

function context(): ClientContext {
  return {
    memory: [],
    knowledge: [],
    truncated: false,
    warnings: [],
  } as ClientContext;
}

describe('ClientWorkflowRegistry knob propagation', () => {
  const registry = new ClientWorkflowRegistry({ selector: stubSelector });

  it('injects client.delayMs into every coordination task input when the knob is set', () => {
    const coordination = registry.build(
      request({ 'client.delayMs': 5000 }),
      context(),
      CLIENT_PROJECT_CREATION_WORKFLOW,
    );
    const tasks = coordination.tasks ?? [];
    expect(tasks.length).toBeGreaterThanOrEqual(1);
    for (const task of tasks) {
      const input = task.input as Readonly<Record<string, unknown>> | undefined;
      expect(input?.['client.delayMs']).toBe(5000);
    }
  });

  it('omits the knob when it is absent', () => {
    const coordination = registry.build(request({}), context(), CLIENT_PROJECT_CREATION_WORKFLOW);
    for (const task of coordination.tasks ?? []) {
      const input = task.input as Readonly<Record<string, unknown>> | undefined;
      expect(input?.['client.delayMs']).toBeUndefined();
    }
  });

  it('forwards the request cancellation signal for mid-flight aborts', () => {
    const controller = new AbortController();
    const coordination = registry.build(
      { ...request({}), cancellation: { requested: false, signal: controller.signal } },
      context(),
      CLIENT_PROJECT_CREATION_WORKFLOW,
    );
    expect(coordination.cancellation).toBe(controller.signal);
  });
});
