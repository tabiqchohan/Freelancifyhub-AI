/**
 * Prompts15 Phase 6 — cancellation and deadline across the execution seams.
 *
 * The inbound signal and the step deadline have to survive two hand-offs that
 * previously dropped them:
 *
 *   1. `ExecutionEngine.execute()` -> `AgentExecutionRequest` (lifecycle)
 *   2. `ProductionAgentExecutor` -> `AIReasoningService.reason()` options
 *
 * Each test fails if the corresponding wiring is reverted.
 */

import { describe, expect, it } from 'vitest';

import { AgentRegistry } from '../../../../src/agents/runtime/registry.js';
import { ProductionAgentExecutor } from '../../../../src/agents/runtime/executor.js';
import { createRuntimeAgent } from '../../../../src/agents/runtime/runtime-agent.js';
import { ExecutionEngine } from '../../../../src/agents/ag-001-master-orchestrator/execution/engine/index.js';
import type {
  AgentExecutionRequest,
  AgentExecutionResult,
} from '../../../../src/agents/ag-001-master-orchestrator/execution/interfaces/index.js';
import { parseExecutionConfig } from '../../../../src/agents/ag-001-master-orchestrator/execution/config/index.js';
import { StaticExecutorRegistry } from '../../../../src/agents/ag-001-master-orchestrator/execution/executors/index.js';
import { ExecutionState } from '../../../../src/agents/ag-001-master-orchestrator/execution/types/index.js';
import { FailurePolicy } from '../../../../src/agents/ag-001-master-orchestrator/planning/types/index.js';
import type {
  AIReasoningServiceContract,
  LLMRequestOptions,
} from '../../../../src/llm/types/index.js';
import {
  baseExecutionRequest,
  buildSinglePlan,
} from '../ag-001-master-orchestrator/execution/fixtures.js';

const policy = {
  timeoutMs: 5_000,
  retry: { maxRetries: 0, retryable: true, backoffMs: 1 },
  failureBehavior: FailurePolicy.FailFast,
  continueOnFailure: false,
  stopOnFailure: true,
  fallbackAllowed: false,
  maxSteps: 1,
  maxTotalExecutionTimeMs: 20_000,
};

/** Records the options each reasoning call receives. */
function recordingReasoning(): {
  readonly service: AIReasoningServiceContract;
  readonly calls: LLMRequestOptions[];
} {
  const calls: LLMRequestOptions[] = [];
  const service: AIReasoningServiceContract = {
    id: 'recording',
    isEnabled: () => true,
    providerInfo: () => ({
      enabled: true,
      configured: true,
      provider: 'recording',
      model: 'recording',
    }),
    reason: async (_request, options = {}) => {
      calls.push(options);
      return {
        output: 'ok',
        provider: 'recording',
        model: 'recording',
        latencyMs: 1,
      };
    },
  };
  return { service, calls };
}

function request(overrides: Partial<AgentExecutionRequest> = {}): AgentExecutionRequest {
  return {
    executionId: 'exec_abort',
    stepId: 'step-1',
    agentId: 'AG-102',
    inputs: { 'request.input': 'create a project' },
    policy,
    traceId: 'trace-abort',
    ...overrides,
  };
}

describe('Prompts15 Phase 6 — executor bridges the inbound signal to reasoning', () => {
  it('passes a live signal to the reasoning service', async () => {
    const { service, calls } = recordingReasoning();
    const registry = new AgentRegistry();
    registry.register(createRuntimeAgent({ agentId: 'AG-102', requiresReasoning: true }));
    const executor = new ProductionAgentExecutor({ registry, reasoningService: service });

    await executor.execute(request({ signal: new AbortController().signal }));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0]?.signal?.aborted).toBe(false);
  });

  it('hands the reasoning service an already-aborted signal when the caller is gone', async () => {
    const { service, calls } = recordingReasoning();
    const registry = new AgentRegistry();
    registry.register(createRuntimeAgent({ agentId: 'AG-102', requiresReasoning: true }));
    const executor = new ProductionAgentExecutor({ registry, reasoningService: service });

    // Before the fix the inbound signal was dropped entirely, so reasoning ran
    // (and billed) work for a caller that had already disconnected.
    await executor.execute(request({ signal: AbortSignal.abort() }));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.signal?.aborted).toBe(true);
  });

  it('aborts the reasoning signal when the caller disconnects mid-execution', async () => {
    const inbound = new AbortController();
    let seen: AbortSignal | undefined;

    const service: AIReasoningServiceContract = {
      id: 'mid-flight',
      isEnabled: () => true,
      providerInfo: () => ({ enabled: true, configured: true, provider: 'p', model: 'm' }),
      reason: async (_request, options = {}) => {
        seen = options.signal;
        // The caller hangs up while the provider call is in flight.
        inbound.abort();
        expect(options.signal?.aborted).toBe(true);
        return { output: 'ok', provider: 'p', model: 'm', latencyMs: 1 };
      },
    };

    const registry = new AgentRegistry();
    registry.register(createRuntimeAgent({ agentId: 'AG-102', requiresReasoning: true }));
    const executor = new ProductionAgentExecutor({ registry, reasoningService: service });

    await executor.execute(request({ signal: inbound.signal }));

    expect(seen?.aborted).toBe(true);
  });

  it('forwards an absolute deadline derived from the step budget', async () => {
    const { service, calls } = recordingReasoning();
    const registry = new AgentRegistry();
    registry.register(createRuntimeAgent({ agentId: 'AG-102', requiresReasoning: true }));
    const executor = new ProductionAgentExecutor({ registry, reasoningService: service });

    const before = Date.now();
    await executor.execute(request());
    const after = Date.now();

    const deadlineAt = calls[0]?.deadlineAt;
    expect(typeof deadlineAt).toBe('number');
    // The step policy allows 5000ms, so the deadline is that window from now.
    expect(deadlineAt!).toBeGreaterThanOrEqual(before + 4_000);
    expect(deadlineAt!).toBeLessThanOrEqual(after + 5_000);
  });

  it('clamps the deadline to the executor default when the step budget is larger', async () => {
    const { service, calls } = recordingReasoning();
    const registry = new AgentRegistry();
    registry.register(createRuntimeAgent({ agentId: 'AG-102', requiresReasoning: true }));
    const executor = new ProductionAgentExecutor({
      registry,
      reasoningService: service,
      defaultTimeoutMs: 1_000,
    });

    const before = Date.now();
    await executor.execute(
      request({ policy: { ...policy, timeoutMs: 600_000 } as AgentExecutionRequest['policy'] }),
    );

    // min(600_000, default 1_000) is the effective guard, so the LLM chain must
    // be bounded by that and not by the step's own large budget.
    const clamped = calls[0]?.deadlineAt;
    expect(typeof clamped).toBe('number');
    expect(clamped ?? Number.MAX_SAFE_INTEGER).toBeLessThanOrEqual(before + 1_000);
  });

  it('stays source-compatible for callers that pass no signal', async () => {
    const { service, calls } = recordingReasoning();
    const registry = new AgentRegistry();
    registry.register(createRuntimeAgent({ agentId: 'AG-102', requiresReasoning: true }));
    const executor = new ProductionAgentExecutor({ registry, reasoningService: service });

    const result = await executor.execute(request());

    expect(result.success).toBe(true);
    expect(calls[0]?.signal?.aborted).toBe(false);
  });
});

describe('Prompts15 Phase 6 — execution engine forwards the signal to each step', () => {
  /** A registry whose single step records the signal it was handed. */
  function registryCapturing(received: AbortSignal[]): StaticExecutorRegistry {
    return new StaticExecutorRegistry([
      {
        id: 'capture-1',
        canExecute: () => true,
        status: () => ({ available: true }),
        execute: async (req: AgentExecutionRequest) => {
          if (req.signal !== undefined) {
            received.push(req.signal);
          }
          return {
            success: true,
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            durationMs: 1,
          } satisfies AgentExecutionResult;
        },
      } as never,
    ]);
  }

  it('hands the inbound signal to the agent step', async () => {
    const received: AbortSignal[] = [];
    const engine = new ExecutionEngine({
      registry: registryCapturing(received),
      config: parseExecutionConfig({ EXECUTION_EVENTS_ENABLED: 'false' }),
    });

    await engine.execute(
      baseExecutionRequest(buildSinglePlan(), { signal: new AbortController().signal }),
    );

    expect(received).toHaveLength(1);
    expect(received[0]?.aborted).toBe(false);
  });

  it('cancels the run when the caller disconnects', async () => {
    const inbound = new AbortController();
    const engine = new ExecutionEngine({
      // A step that never settles, so cancellation is the only way out.
      registry: new StaticExecutorRegistry([
        {
          id: 'hang-1',
          canExecute: () => true,
          status: () => ({ available: true }),
          execute: async () => new Promise<AgentExecutionResult>(() => undefined),
        } as never,
      ]),
      config: parseExecutionConfig({ EXECUTION_EVENTS_ENABLED: 'false' }),
    });

    const run = engine.execute(baseExecutionRequest(buildSinglePlan(), { signal: inbound.signal }));

    setTimeout(() => inbound.abort(), 20);
    const result = await run;

    // The engine settled as cancelled rather than hanging on the agent.
    expect(result.state).toBe(ExecutionState.Cancelled);
  });

  it('detaches the inbound link once the run completes', async () => {
    const inbound = new AbortController();
    const received: AbortSignal[] = [];
    const engine = new ExecutionEngine({
      registry: registryCapturing(received),
      config: parseExecutionConfig({ EXECUTION_EVENTS_ENABLED: 'false' }),
    });

    await engine.execute(baseExecutionRequest(buildSinglePlan(), { signal: inbound.signal }));

    // Aborting a completed run must not resurrect it or throw.
    inbound.abort();
    expect(() => engine.cancel('exec-1', 'too late')).not.toThrow();
  });
});
