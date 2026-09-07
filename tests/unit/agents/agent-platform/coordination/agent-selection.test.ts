import { describe, expect, it } from 'vitest';

import { AgentSelector } from '../../../../../src/agents/agent-platform/coordination/agent-selection.js';
import { AGENT_SELECTION_REASONS } from '../../../../../src/agents/agent-platform/coordination/agent-selection.js';
import { CoordinationAgentRejectedError } from '../../../../../src/agents/agent-platform/coordination/errors.js';
import { capability } from '../../../../../src/agents/agent-platform/schemas.js';
import { AgentLifecycleState } from '../../../../../src/agents/agent-platform/lifecycle.js';
import {
  dummyExecutorRegistry,
  executorRegistryOf,
  makeDefinition,
  readableGateway,
  readableRegistry,
} from './fakes.js';
import type { FakeExecutor } from './fakes.js';
import type { TaskInvocation } from '../../../../../src/agents/agent-platform/coordination/types.js';

function invocation(overrides: Partial<TaskInvocation> = {}): TaskInvocation {
  return {
    taskId: 't1',
    agentId: 'AG-200',
    objective: 'sel',
    input: {},
    dependencies: [],
    requiredCapabilities: [],
    requiredTools: [],
    priority: 0,
    timeoutMs: 5000,
    retry: { maxRetries: 0, retryable: false, backoffMs: 0, backoffMultiplier: 1, maxBackoffMs: 0 },
    ...overrides,
  };
}

const unavailable = (agentId: string): FakeExecutor => ({
  agentId,
  available: false,
  canExecute: (target: string) => target === agentId,
  status: () => ({ available: false }),
  execute: async () => ({ success: true }),
  cancel: async () => undefined,
});

describe('AgentSelector (Sprint 20 §8)', () => {
  it('selects a READY, executor-backed, within-limit agent', () => {
    const selector = new AgentSelector({
      registry: readableRegistry([makeDefinition('AG-200')]),
      gateway: readableGateway(),
      executorRegistry: dummyExecutorRegistry(),
    });
    expect(selector.select(invocation()).selected).toBe(true);
  });

  it('rejects an unregistered agent', () => {
    const selector = new AgentSelector({
      registry: readableRegistry([]),
      gateway: readableGateway(),
      executorRegistry: { resolve: () => undefined } as never,
    });
    const result = selector.select(invocation());
    expect(result.selected).toBe(false);
    expect(result.reasonCode).toBe(AGENT_SELECTION_REASONS.NO_EXECUTOR);
  });

  it('rejects an agent in an unready lifecycle state', () => {
    const registry = {
      getAgent: (agentId: string) => makeDefinition(agentId),
      lifecycleStateOf: () => AgentLifecycleState.Paused,
      lifecycleController: { activeExecutionCount: () => 0 },
    } as unknown as ReturnType<typeof readableRegistry>;
    const selector = new AgentSelector({
      registry,
      gateway: readableGateway(),
      executorRegistry: dummyExecutorRegistry(),
    });
    const result = selector.select(invocation());
    expect(result.selected).toBe(false);
    expect(result.reasonCode).toBe(AGENT_SELECTION_REASONS.NOT_READY);
  });

  it('rejects an agent marked for draining', () => {
    const registry = {
      getAgent: (agentId: string) => makeDefinition(agentId),
      lifecycleStateOf: () => AgentLifecycleState.Draining,
      lifecycleController: { activeExecutionCount: () => 0 },
    } as unknown as ReturnType<typeof readableRegistry>;
    const selector = new AgentSelector({
      registry,
      gateway: readableGateway(),
      executorRegistry: dummyExecutorRegistry(),
    });
    expect(selector.select(invocation()).reasonCode).toBe(AGENT_SELECTION_REASONS.NOT_READY);
  });

  it('rejects when no executor claims the agent', () => {
    const selector = new AgentSelector({
      registry: readableRegistry([makeDefinition('AG-200')]),
      gateway: readableGateway(),
      executorRegistry: { resolve: () => undefined },
    });
    expect(selector.select(invocation()).reasonCode).toBe(AGENT_SELECTION_REASONS.NO_EXECUTOR);
  });

  it('rejects an unavailable executor', () => {
    const selector = new AgentSelector({
      registry: readableRegistry([makeDefinition('AG-200')]),
      gateway: readableGateway(),
      executorRegistry: executorRegistryOf([unavailable('AG-200')]),
    });
    expect(selector.select(invocation()).reasonCode).toBe(
      AGENT_SELECTION_REASONS.EXECUTOR_UNAVAILABLE,
    );
  });

  it('rejects missing and disabled capabilities', () => {
    const selector = new AgentSelector({
      registry: readableRegistry([
        makeDefinition('AG-200', { capabilities: [capability('c1', false)] }),
      ]),
      gateway: readableGateway(),
      executorRegistry: dummyExecutorRegistry(),
    });
    expect(selector.select(invocation({ requiredCapabilities: ['nope'] })).reasonCode).toBe(
      AGENT_SELECTION_REASONS.CAPABILITY_MISSING,
    );
    expect(selector.select(invocation({ requiredCapabilities: ['c1'] })).reasonCode).toBe(
      AGENT_SELECTION_REASONS.CAPABILITY_DISABLED,
    );
  });

  it('accepts declared + enabled capabilities', () => {
    const selector = new AgentSelector({
      registry: readableRegistry([
        makeDefinition('AG-200', { capabilities: [capability('c1', true)] }),
      ]),
      gateway: readableGateway(),
      executorRegistry: dummyExecutorRegistry(),
    });
    expect(selector.select(invocation({ requiredCapabilities: ['c1'] })).selected).toBe(true);
  });

  it('rejects tools outside the allowlist', () => {
    const selector = new AgentSelector({
      registry: readableRegistry([makeDefinition('AG-200', { allowedTools: ['calculator'] })]),
      gateway: readableGateway(),
      executorRegistry: dummyExecutorRegistry(),
    });
    expect(selector.select(invocation({ requiredTools: ['database'] })).reasonCode).toBe(
      AGENT_SELECTION_REASONS.TOOL_NOT_ALLOWED,
    );
    expect(selector.select(invocation({ requiredTools: ['calculator'] })).selected).toBe(true);
  });

  it('rejects agents at their concurrency limit', () => {
    const registry = {
      getAgent: (agentId: string) =>
        makeDefinition(agentId, {
          limits: { ...makeDefinition(agentId).limits, maxConcurrentExecutions: 1 },
        }),
      lifecycleStateOf: () => AgentLifecycleState.Ready,
      lifecycleController: { activeExecutionCount: () => 1 },
    } as unknown as ReturnType<typeof readableRegistry>;
    const selector = new AgentSelector({
      registry,
      gateway: readableGateway(),
      executorRegistry: dummyExecutorRegistry(),
    });
    expect(selector.select(invocation()).reasonCode).toBe(
      AGENT_SELECTION_REASONS.CONCURRENCY_LIMIT,
    );
  });

  it('assertAll throws the typed rejection for rejected tasks', () => {
    const selector = new AgentSelector({
      registry: readableRegistry([]),
      gateway: readableGateway(),
      executorRegistry: { resolve: () => undefined } as never,
    });
    expect(() => selector.assertAll([invocation()])).toThrow(CoordinationAgentRejectedError);
  });
});
