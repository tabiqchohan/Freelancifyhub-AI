import { describe, expect, it } from 'vitest';

import { AgentDefinitionRegistry } from '../../../../src/agents/agent-platform/registry.js';
import {
  AgentPlatformGateway,
  normalizeGateFailure,
} from '../../../../src/agents/agent-platform/gateway.js';
import { AgentPlatformMetrics } from '../../../../src/agents/agent-platform/metrics.js';
import { AgentPlatformEventLog } from '../../../../src/agents/agent-platform/events.js';
import { AgentExecutionMode } from '../../../../src/agents/agent-platform/types.js';
import type { AgentExecutionGateInput } from '../../../../src/agents/agent-platform/types.js';
import { AgentCapabilityDeniedError } from '../../../../src/agents/agent-platform/errors.js';
import { makeDefinition } from './fixtures.js';

function gateInput(overrides: Partial<AgentExecutionGateInput> = {}): AgentExecutionGateInput {
  return {
    executionId: 'exec-1',
    agentId: 'AG-222',
    executionMode: AgentExecutionMode.Deterministic,
    capabilities: ['project.read.describe'],
    permissions: ['memory.read'],
    ...overrides,
  };
}

function makeGateway(
  options: {
    define?: typeof makeDefinition;
    onTool?: (name: string) => boolean;
  } = {},
) {
  const registry = new AgentDefinitionRegistry({ toolExists: options.onTool });
  const metrics = new AgentPlatformMetrics();
  const eventLog = new AgentPlatformEventLog();
  registry.registerAgent((options.define ?? makeDefinition)(), { activate: true });
  const gateway = new AgentPlatformGateway({ registry, metrics, eventLog });
  return { registry, metrics, eventLog, gateway };
}

describe('AgentPlatformGateway', () => {
  it('grants a lease when the definition matches the claims', () => {
    const { gateway } = makeGateway();
    const result = gateway.beginExecution(gateInput());
    expect(result.lease?.agentId).toBe('AG-222');
    expect(result.lease?.executionId).toBe('exec-1');
    expect(result.lease?.allowedTools).toEqual([]);
    expect(result.failure).toBeUndefined();
  });

  it('rejects unregistered agents as a normalized failure (no throw)', () => {
    const { gateway } = makeGateway();
    const result = gateway.beginExecution(gateInput({ agentId: 'AG-NOPE' }));
    expect(result.failure?.code).toBe('AGENT_NOT_FOUND');
    expect(result.failure?.retryable).toBe(false);
    expect(result.lease).toBeUndefined();
  });

  it('rejects agents that are not lifecycle-ready', () => {
    const { registry, gateway } = makeGateway();
    registry.pauseAgent('AG-222');
    const result = gateway.beginExecution(gateInput());
    expect(result.failure?.code).toBe('AGENT_NOT_READY');
    expect(result.failure?.details?.lifecycleState).toBe('PAUSED');
  });

  it('rejects version mismatch', () => {
    const { gateway } = makeGateway();
    const result = gateway.beginExecution(gateInput({ agentVersion: '9.9.9' }));
    expect(result.failure?.code).toBe('AGENT_VERSION_CONFLICT');
  });

  it('rejects undeclared capabilities with a typed policy event', () => {
    const { eventLog, metrics, gateway } = makeGateway();
    const result = gateway.beginExecution(gateInput({ capabilities: ['project.delete'] }));
    expect(result.failure?.code).toBe('AGENT_CAPABILITY_DENIED');
    expect(result.failure?.details?.capability).toBe('project.delete');
    expect(metrics.snapshot().counts.capabilityDenials).toBe(1);
    const denied = eventLog.query({ type: 'agent.capability.denied' });
    expect(denied.total).toBe(1);
    expect(denied.items[0]?.metadata?.capability).toBe('project.delete');
  });

  it('rejects unsupported execution modes', () => {
    const { gateway } = makeGateway();
    const result = gateway.beginExecution(gateInput({ executionMode: AgentExecutionMode.Agentic }));
    expect(result.failure?.code).toBe('AGENT_CAPABILITY_DENIED');
  });

  it('rejects ungranted permissions', () => {
    const { metrics, gateway } = makeGateway();
    const result = gateway.beginExecution(gateInput({ permissions: ['admin.operations'] }));
    expect(result.failure?.code).toBe('AGENT_PERMISSION_DENIED');
    expect(result.failure?.details?.permission).toBe('admin.operations');
    expect(metrics.snapshot().counts.permissionDenials).toBe(1);
  });

  it('enforces the concurrency limit and is retryable', () => {
    const { metrics, gateway } = makeGateway({
      define: () =>
        makeDefinition({
          limits: {
            ...makeDefinition().limits,
            maxConcurrentExecutions: 1,
          },
        }),
    });
    const first = gateway.beginExecution(gateInput({ executionId: 'exec-1' }));
    expect(first.lease?.executionId).toBe('exec-1');
    const second = gateway.beginExecution(gateInput({ executionId: 'exec-2' }));
    expect(second.failure?.code).toBe('AGENT_EXECUTION_LIMIT_REACHED');
    expect(second.failure?.retryable).toBe(true);
    expect(metrics.snapshot().counts.executionLimitDenials).toBe(1);
    expect(metrics.snapshot().counts.rejectedExecutions).toBe(1);

    gateway.endExecution({ agentId: 'AG-222', executionId: 'exec-1' });
    const third = gateway.beginExecution(gateInput({ executionId: 'exec-3' }));
    expect(third.lease?.executionId).toBe('exec-3');
  });

  it('releases the slot and records duration on endExecution', () => {
    let clock = 0;
    const { registry, metrics } = makeGateway({});
    const gateway = new AgentPlatformGateway({
      registry,
      metrics,
      performanceNow: () => clock,
    });
    const result = gateway.beginExecution(gateInput());
    if (result.lease === undefined) {
      throw new Error('expected lease');
    }
    clock = 250;
    gateway.endExecution({ agentId: 'AG-222', executionId: 'exec-1', startedAtMs: 0 });
    expect(metrics.snapshot().counts.executionCompletions).toBe(1);
    expect(metrics.snapshot().counts.totalExecutionMs).toBe(250);
    expect(registry.lifecycleController.activeExecutionCount('AG-222')).toBe(0);
  });

  it('isToolAllowed reflects the definition allowlist (fail-closed)', () => {
    const { gateway } = makeGateway({
      define: () => makeDefinition({ allowedTools: ['memory_read', 'memory_write'] }),
    });
    expect(gateway.isToolAllowed('AG-222', 'memory_read')).toBe(true);
    expect(gateway.isToolAllowed('AG-222', 'files_write')).toBe(false);
    expect(gateway.isToolAllowed('AG-UNREGISTERED', 'memory_read')).toBe(false);
  });
});

describe('normalizeGateFailure', () => {
  it('maps known platform errors to normalized failures', () => {
    const normalized = normalizeGateFailure(
      new AgentCapabilityDeniedError('no capability', { capability: 'x' }),
      'AG-222',
    );
    expect(normalized.code).toBe('AGENT_CAPABILITY_DENIED');
    expect(normalized.retryable).toBe(false);
  });

  it('maps unknown errors to a safe fallback', () => {
    const normalized = normalizeGateFailure(undefined, 'AG-222');
    expect(normalized.code).toBe('AGENT_NOT_READY');
    expect(normalized.message).toContain('AG-222');
  });
});
