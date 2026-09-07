import { describe, expect, it } from 'vitest';

import {
  CoordinationPlanner,
  resolveLimits,
} from '../../../../../src/agents/agent-platform/coordination/task-decomposition.js';
import { AgentSelector } from '../../../../../src/agents/agent-platform/coordination/agent-selection.js';
import {
  CoordinationLimitError,
  CoordinationPlanInvalidError,
} from '../../../../../src/agents/agent-platform/coordination/errors.js';
import { CoordinationMode } from '../../../../../src/agents/agent-platform/coordination/types.js';
import {
  createCoordinationIdFactory,
  resolveCoordinationId,
} from '../../../../../src/agents/agent-platform/coordination/ids.js';
import {
  dummyExecutorRegistry,
  makeDefinition,
  readableGateway,
  readableRegistry,
} from './fakes.js';

describe('CoordinationPlanner (Sprint 20 §5/§6)', () => {
  it('builds a plan from pre-built tasks', () => {
    const selector = new AgentSelector({
      registry: readableRegistry([makeDefinition('AG-200')]),
      gateway: readableGateway(),
      executorRegistry: dummyExecutorRegistry(),
    });
    const planner = new CoordinationPlanner(selector, {
      coordinationIdFactory: createCoordinationIdFactory(),
    });
    const plan = planner.plan({
      correlationId: 'corr-1',
      requester: 'AG-001',
      objective: 'coordinate',
      mode: CoordinationMode.Parallel,
      tasks: [
        { taskId: 't1', agentId: 'AG-200', objective: 'task one' },
        { taskId: 't2', agentId: 'AG-200', objective: 'task two' },
      ],
    });
    expect(plan.coordinationId).toMatch(/^coord_/);
    expect(plan.tasks).toHaveLength(2);
    expect(plan.failurePolicy).toBe('FAIL_FAST');
    expect(plan.conflictPolicy).toBe('FAIL_ON_CONFLICT');
    expect(plan.aggregation).toBe('COLLECT');
  });

  it('auto-decomposes SEQUENTIAL participants into a chain', () => {
    const selector = new AgentSelector({
      registry: readableRegistry([makeDefinition('AG-200'), makeDefinition('AG-201')]),
      gateway: readableGateway(),
      executorRegistry: dummyExecutorRegistry(),
    });
    const planner = new CoordinationPlanner(selector);
    const plan = planner.plan({
      correlationId: 'corr-1',
      requester: 'AG-001',
      objective: 'chain',
      mode: CoordinationMode.Sequential,
      participatingAgents: ['AG-200', 'AG-201'],
    });
    expect(plan.tasks.map((t) => t.taskId)).toEqual(['t1', 't2']);
    expect(plan.tasks[1]?.dependencies).toEqual(['t1']);
    expect(plan.tasks[0]?.dependencies).toEqual([]);
    expect(plan.tasks[1]?.priority).toBeLessThan(plan.tasks[0]?.priority ?? 0);
  });

  it('auto-decomposes PARALLEL participants without edges', () => {
    const selector = new AgentSelector({
      registry: readableRegistry([makeDefinition('AG-200'), makeDefinition('AG-201')]),
      gateway: readableGateway(),
      executorRegistry: dummyExecutorRegistry(),
    });
    const planner = new CoordinationPlanner(selector);
    const plan = planner.plan({
      correlationId: 'corr-1',
      requester: 'AG-001',
      objective: 'fan-out',
      mode: CoordinationMode.Parallel,
      participatingAgents: ['AG-200', 'AG-201'],
    });
    expect(plan.tasks.every((t) => t.dependencies.length === 0)).toBe(true);
  });

  it('requires exactly one participant for SINGLE mode', () => {
    const selector = new AgentSelector({
      registry: readableRegistry([]),
      gateway: readableGateway(),
      executorRegistry: dummyExecutorRegistry(),
    });
    const planner = new CoordinationPlanner(selector);
    expect(() =>
      planner.plan({
        correlationId: 'corr-1',
        requester: 'AG-001',
        objective: 'single',
        mode: CoordinationMode.Single,
        participatingAgents: ['AG-200', 'AG-201'],
      }),
    ).toThrow(CoordinationPlanInvalidError);
  });

  it('rejects too many tasks and invalid timeouts', () => {
    const selector = new AgentSelector({
      registry: readableRegistry([]),
      gateway: readableGateway(),
      executorRegistry: dummyExecutorRegistry(),
    });
    const planner = new CoordinationPlanner(selector);
    expect(() =>
      planner.plan({
        correlationId: 'corr-1',
        requester: 'AG-001',
        objective: 'overflow',
        mode: CoordinationMode.Parallel,
        limits: { maxTasks: 2 },
        tasks: [
          { taskId: 't1', agentId: 'AG-200', objective: 'a' },
          { taskId: 't2', agentId: 'AG-200', objective: 'b' },
          { taskId: 't3', agentId: 'AG-200', objective: 'c' },
        ],
      }),
    ).toThrow(CoordinationLimitError);
    expect(() =>
      planner.plan({
        correlationId: 'corr-1',
        requester: 'AG-001',
        objective: 'timeout',
        mode: CoordinationMode.Single,
        limits: { globalTimeoutMs: 1000 },
        tasks: [{ taskId: 't1', agentId: 'AG-200', objective: 'a', timeoutMs: 2000 }],
      }),
    ).toThrow(CoordinationLimitError);
  });

  it('resolveLimits applies bounds and defaults', () => {
    expect(resolveLimits()).toMatchObject({ maxTasks: 16, maxConcurrentTasks: 4 });
    expect(resolveLimits({ maxConcurrentTasks: 8 }).maxConcurrentTasks).toBe(8);
    expect(() => resolveLimits({ maxTasks: 0 })).toThrow(CoordinationLimitError);
    expect(() => resolveLimits({ maxTasks: 100 })).toThrow(CoordinationLimitError);
  });

  it('uses a server-generated coordination id when omitted', () => {
    const selector = new AgentSelector({
      registry: readableRegistry([makeDefinition('AG-200')]),
      gateway: readableGateway(),
      executorRegistry: dummyExecutorRegistry(),
    });
    const planner = new CoordinationPlanner(selector, {
      coordinationIdFactory: () => 'coord_custom',
    });
    const plan = planner.plan({
      correlationId: 'corr-1',
      requester: 'AG-001',
      objective: 'cid',
      mode: CoordinationMode.Single,
      tasks: [{ taskId: 't1', agentId: 'AG-200', objective: 'x' }],
    });
    expect(plan.coordinationId).toBe('coord_custom');
    expect(resolveCoordinationId()).toMatch(/^coord_/);
  });
});
