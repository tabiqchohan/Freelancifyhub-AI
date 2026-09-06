import { describe, expect, it } from 'vitest';

import { AgenticLoopService } from '../../../../../src/agents/runtime/agentic/loop.js';
import { AgenticEventLog } from '../../../../../src/agents/runtime/agentic/events.js';
import { AgenticLoopMetrics } from '../../../../../src/agents/runtime/agentic/metrics.js';
import { AgenticConfigSchema } from '../../../../../src/agents/runtime/agentic/config.js';
import {
  AgenticLoopStatus,
  ToolCallStatus,
} from '../../../../../src/agents/runtime/agentic/contracts.js';
import {
  ToolActorGroup,
  ToolResultStatus,
  type ToolActor,
  type ToolJsonValue,
  type ToolResult,
} from '../../../../../src/agents/ag-004-tool-manager/index.js';
import type {
  AIReasoningServiceContract,
  LLMProviderStatus,
  ReasoningRequest,
  ReasoningResult,
  LLMRequestOptions,
} from '../../../../../src/llm/types/index.js';
import type {
  AgenticToolCoordinator,
  AgenticToolInfo,
} from '../../../../../src/agents/runtime/agentic/tools.js';

/** Scripted reasoning fake returning canned structured decisions. */
class FakeReasoning implements AIReasoningServiceContract {
  readonly id = 'fake-reasoning';
  enabled = true;
  calls: Array<{ request: ReasoningRequest; options?: LLMRequestOptions }> = [];
  private queue: string[] = [];

  constructor(private readonly model = 'fake-model-1.0') {}

  isEnabled(): boolean {
    return this.enabled;
  }

  providerInfo(): LLMProviderStatus {
    return { enabled: this.enabled, configured: true, provider: 'fake', model: this.model };
  }

  then(output: string): FakeReasoning {
    this.queue.push(output);
    return this;
  }

  async reason(request: ReasoningRequest, options?: LLMRequestOptions): Promise<ReasoningResult> {
    this.calls.push({ request, options });
    const output = this.queue.shift();
    if (output === undefined) {
      throw new Error('FakeReasoning exhausted its scripted outputs');
    }
    return {
      output,
      provider: 'fake',
      model: this.model,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      latencyMs: 1,
      correlationId: `fake-${this.calls.length}`,
    };
  }
}

/** Scripted coordinator fake with no direct AG-004 internals. */
class FakeCoordinator implements AgenticToolCoordinator {
  toolNames: string[] = ['calculator'];
  executeCalls: string[] = [];
  private nextStatus: ToolResultStatus = ToolResultStatus.Success;
  private nextOutput: unknown = { result: 42 };

  get(name: string): AgenticToolInfo | undefined {
    if (!this.toolNames.includes(name)) {
      return undefined;
    }
    return {
      name,
      version: '1.0.0',
      description: 'fake',
      category: 'COMPUTATION',
      securityLevel: 'INTERNAL',
      enabled: true,
      inputSchemaDescription: '{}',
    };
  }

  list(): readonly AgenticToolInfo[] {
    return this.toolNames.map((name) => ({
      name,
      version: '1.0.0',
      description: 'fake',
      category: 'COMPUTATION',
      securityLevel: 'INTERNAL',
      enabled: true,
      inputSchemaDescription: '{}',
    }));
  }

  plays(status: ToolResultStatus, output: unknown): void {
    this.nextStatus = status;
    this.nextOutput = output;
  }

  async execute(name: string): Promise<ToolResult> {
    this.executeCalls.push(name);
    const status = this.nextStatus;
    return {
      toolId: `tool_${name}_1.0.0`,
      toolName: name,
      toolVersion: '1.0.0',
      executionId: 'exec-fake',
      durationMs: 2,
      status,
      output:
        status === ToolResultStatus.Success && isToolJson(this.nextOutput)
          ? this.nextOutput
          : undefined,
      errorCode: status === ToolResultStatus.Success ? undefined : 'TOOL_EXECUTION_FAILED',
      errorMessage: status === ToolResultStatus.Success ? undefined : 'fake failure',
      attempts: 1,
    };
  }
}

function isToolJson(value: unknown): value is ToolJsonValue {
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every((item) => isToolJson(item));
  }
  if (typeof value === 'object') {
    return Object.values(value).every((item) => isToolJson(item));
  }
  return false;
}

const config = AgenticConfigSchema.parse({});

const actor: ToolActor = {
  group: ToolActorGroup.Orchestrator,
  id: 'agentic-test',
  namespaces: ['default'],
};

function makeLoop(input: { reasoning: FakeReasoning; tools: AgenticToolCoordinator }): {
  loop: AgenticLoopService;
  events: AgenticEventLog;
  metrics: AgenticLoopMetrics;
} {
  const events = new AgenticEventLog();
  const metrics = new AgenticLoopMetrics();
  const loop = new AgenticLoopService({
    reasoning: input.reasoning,
    tools: input.tools,
    config,
    eventLog: events,
    metrics,
    defaultNamespace: 'default',
  });
  return { loop, events, metrics };
}

function runInput(overrides: { userInput?: string } = {}): {
  userInput: string;
  actor: ToolActor;
  namespace: string;
} {
  return {
    userInput: overrides.userInput ?? 'do the thing',
    actor,
    namespace: 'default',
  };
}

describe('agentic loop service (Sprint 18)', () => {
  it('completes immediately on a FINAL_RESPONSE decision', async () => {
    const reasoning = new FakeReasoning().then(
      JSON.stringify({ type: 'FINAL_RESPONSE', response: 'All done.' }),
    );
    const tools = new FakeCoordinator();
    const { loop, events, metrics } = makeLoop({ reasoning, tools });

    const result = await loop.run(runInput());
    expect(result.status).toBe(AgenticLoopStatus.Completed);
    expect(result.finalResponse).toBe('All done.');
    expect(result.turns).toBe(1);
    expect(result.reasoningCalls).toBe(1);
    expect(result.toolCalls).toHaveLength(0);
    expect(result.usage.totalTokens).toBe(15);
    expect(events.count()).toBeGreaterThanOrEqual(4);
    expect(metrics.snapshot().totals.operations).toBe(1);
  });

  it('ends with Clarification on a CLARIFICATION_REQUIRED decision', async () => {
    const reasoning = new FakeReasoning().then(
      JSON.stringify({ type: 'CLARIFICATION_REQUIRED', question: 'Which budget?' }),
    );
    const tools = new FakeCoordinator();
    const { loop } = makeLoop({ reasoning, tools });

    const result = await loop.run(runInput());
    expect(result.status).toBe(AgenticLoopStatus.Clarification);
    expect(result.clarification).toBe('Which budget?');
  });

  it('ends with Aborted on an ABORT decision', async () => {
    const reasoning = new FakeReasoning().then(
      JSON.stringify({ type: 'ABORT', reason: 'Out of scope' }),
    );
    const tools = new FakeCoordinator();
    const { loop } = makeLoop({ reasoning, tools });

    const result = await loop.run(runInput());
    expect(result.status).toBe(AgenticLoopStatus.Aborted);
    expect(result.finalResponse).toBe('Out of scope');
  });

  it('executes a tool call through the coordinator and then completes', async () => {
    const reasoning = new FakeReasoning()
      .then(
        JSON.stringify({ type: 'TOOL_CALL', tool: 'calculator', arguments: { expression: '1+1' } }),
      )
      .then(JSON.stringify({ type: 'FINAL_RESPONSE', response: 'The answer is 42.' }));
    const tools = new FakeCoordinator();
    const { loop } = makeLoop({ reasoning, tools });

    const result = await loop.run(runInput());
    expect(result.status).toBe(AgenticLoopStatus.Completed);
    expect(tools.executeCalls).toEqual(['calculator']);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.status).toBe(ToolCallStatus.Succeeded);
    expect(result.reasoningCalls).toBe(2);
    expect(result.finalResponse).toBe('The answer is 42.');
  });

  it('feeds a rejected tool call back and continues to a fresh decision', async () => {
    const reasoning = new FakeReasoning()
      .then(JSON.stringify({ type: 'TOOL_CALL', tool: 'missing-tool', arguments: {} }))
      .then(JSON.stringify({ type: 'FINAL_RESPONSE', response: 'No tool available.' }));
    const tools = new FakeCoordinator();
    const { loop } = makeLoop({ reasoning, tools });

    const result = await loop.run(runInput());
    expect(result.status).toBe(AgenticLoopStatus.Completed);
    expect(result.rejections).toHaveLength(1);
    expect(result.rejections[0]?.code).toBe('TOOL_NOT_FOUND');
    // The rejected proposal must never reach AG-004 execution.
    expect(tools.executeCalls).toHaveLength(0);
    expect(result.reasoningCalls).toBe(2);
  });

  it('denies a tool call not on the platform allowlist (Sprint 19)', async () => {
    const reasoning = new FakeReasoning()
      .then(
        JSON.stringify({ type: 'TOOL_CALL', tool: 'calculator', arguments: { expression: '1+1' } }),
      )
      .then(JSON.stringify({ type: 'FINAL_RESPONSE', response: 'Nothing to compute.' }));
    const tools = new FakeCoordinator();
    const { loop } = makeLoop({ reasoning, tools });

    const result = await loop.run({ ...runInput(), allowedTools: [] });
    expect(result.status).toBe(AgenticLoopStatus.Completed);
    expect(result.rejections).toHaveLength(1);
    expect(result.rejections[0]?.code).toBe('TOOL_NOT_ALLOWED');
    expect(tools.executeCalls).toEqual([]);
    expect(result.reasoningCalls).toBe(2);
  });

  it('executes a tool that is on the platform allowlist (Sprint 19)', async () => {
    const reasoning = new FakeReasoning()
      .then(
        JSON.stringify({ type: 'TOOL_CALL', tool: 'calculator', arguments: { expression: '1+1' } }),
      )
      .then(JSON.stringify({ type: 'FINAL_RESPONSE', response: 'The answer is 42.' }));
    const tools = new FakeCoordinator();
    const { loop } = makeLoop({ reasoning, tools });

    const result = await loop.run({ ...runInput(), allowedTools: ['calculator'] });
    expect(result.status).toBe(AgenticLoopStatus.Completed);
    expect(tools.executeCalls).toEqual(['calculator']);
    expect(result.rejections).toHaveLength(0);
  });

  it('only exposes allowlisted tools to the model (Sprint 19)', async () => {
    const reasoning = new FakeReasoning().then(
      JSON.stringify({ type: 'FINAL_RESPONSE', response: 'ok' }),
    );
    const tools = new FakeCoordinator();
    const { loop } = makeLoop({ reasoning, tools });

    await loop.run({ ...runInput(), allowedTools: ['other-tool'] });
    const lastCall = reasoning.calls[reasoning.calls.length - 1];
    expect(lastCall?.request.context?.availableTools).toEqual([]);
  });

  it('feeds an authorization-failed execution back as a REJECTED bounded result', async () => {
    const reasoning = new FakeReasoning()
      .then(JSON.stringify({ type: 'TOOL_CALL', tool: 'calculator', arguments: {} }))
      .then(JSON.stringify({ type: 'FINAL_RESPONSE', response: 'Done.' }));
    const tools = new FakeCoordinator();
    tools.plays(ToolResultStatus.AuthorizationFailed, undefined);
    const { loop } = makeLoop({ reasoning, tools });

    const result = await loop.run(runInput());
    expect(result.status).toBe(AgenticLoopStatus.Completed);
    expect(result.toolCalls[0]?.status).toBe(ToolCallStatus.Rejected);
    expect(result.toolCalls[0]?.resultStatus).toBe(ToolResultStatus.AuthorizationFailed);
  });

  it('feeds a failed execution back as a bounded FAILED result and continues', async () => {
    const reasoning = new FakeReasoning()
      .then(JSON.stringify({ type: 'TOOL_CALL', tool: 'calculator', arguments: {} }))
      .then(JSON.stringify({ type: 'FINAL_RESPONSE', response: 'The tool errored.' }));
    const tools = new FakeCoordinator();
    tools.plays(ToolResultStatus.ExecutionFailed, undefined);
    const { loop } = makeLoop({ reasoning, tools });

    const result = await loop.run(runInput());
    expect(result.status).toBe(AgenticLoopStatus.Completed);
    expect(result.toolCalls[0]?.status).toBe(ToolCallStatus.Failed);
    expect(result.toolCalls[0]?.errorCode).toBe('TOOL_EXECUTION_FAILED');
  });

  it('fails closed when the model decision cannot be parsed', async () => {
    const reasoning = new FakeReasoning().then('This is not a structured decision.');
    const tools = new FakeCoordinator();
    const { loop, events } = makeLoop({ reasoning, tools });

    const result = await loop.run(runInput());
    expect(result.status).toBe(AgenticLoopStatus.Failed);
    expect(result.errorCode).toBe('TOOL_DECISION_NO_ENVELOPE');
    expect(result.retryable).toBe(false);
    expect(events.count()).toBeGreaterThanOrEqual(3);
  });

  it('fails closed when reasoning is disabled', async () => {
    const reasoning = new FakeReasoning();
    reasoning.enabled = false;
    const tools = new FakeCoordinator();
    const loop = new AgenticLoopService({
      reasoning,
      tools,
      config,
      defaultNamespace: 'default',
    });

    expect(loop.isEnabled()).toBe(false);
  });

  it('respects the max-turns limit', async () => {
    const reasoning = new FakeReasoning();
    for (let i = 0; i < 10; i += 1) {
      reasoning.then(
        JSON.stringify({
          type: 'TOOL_CALL',
          tool: 'calculator',
          arguments: { expression: `${i}` },
        }),
      );
    }
    const tools = new FakeCoordinator();
    const { loop } = makeLoop({ reasoning, tools });

    const result = await loop.run(runInput());
    expect(result.status).toBe(AgenticLoopStatus.LimitReached);
    expect(result.errorCode).toBe('AGENTIC_LOOP_LIMIT_REACHED');
  });

  it('cancels cooperatively via AbortSignal', async () => {
    const controller = new AbortController();
    const reasoning = new FakeReasoning();
    for (let i = 0; i < 10; i += 1) {
      reasoning.then(JSON.stringify({ type: 'TOOL_CALL', tool: 'calculator', arguments: {} }));
    }
    const tools = new FakeCoordinator();
    const { loop } = makeLoop({ reasoning, tools });

    const promise = loop.run({ ...runInput(), signal: controller.signal });
    controller.abort();

    const result = await promise;
    expect(result.status).toBe(AgenticLoopStatus.Cancelled);
    expect(result.errorCode).toBe('AGENTIC_LOOP_CANCELLED');
  });

  it('propagates the whole-operation deadline as the tool timeout', async () => {
    let capturedTimeout: number | undefined;
    const reasoning = new FakeReasoning()
      .then(JSON.stringify({ type: 'TOOL_CALL', tool: 'calculator', arguments: {} }))
      .then(JSON.stringify({ type: 'FINAL_RESPONSE', response: 'ok' }));
    const tools = new FakeCoordinator();

    const realTools: AgenticToolCoordinator = {
      get: (t) => tools.get(t),
      list: () => tools.list(),
      execute: (name, _input, context) => {
        capturedTimeout = context.timeoutMs;
        return tools.execute(name);
      },
    };

    const { loop } = makeLoop({ reasoning, tools: realTools });
    await loop.run({ ...runInput(), timeoutMs: 5000 });
    expect(typeof capturedTimeout).toBe('number');
    expect(capturedTimeout as number).toBeGreaterThan(0);
    expect(capturedTimeout as number).toBeLessThanOrEqual(5000);
  });

  it('logs operation, reasoning, tool, and completion events', async () => {
    const reasoning = new FakeReasoning()
      .then(
        JSON.stringify({ type: 'TOOL_CALL', tool: 'calculator', arguments: { expression: '2*3' } }),
      )
      .then(JSON.stringify({ type: 'FINAL_RESPONSE', response: '6' }));
    const tools = new FakeCoordinator();
    const { loop, events } = makeLoop({ reasoning, tools });

    await loop.run(runInput());

    const types = events.query({}).items.map((event) => event.type);
    expect(types).toContain('agentic.operation.started');
    expect(types).toContain('agentic.reasoning.started');
    expect(types).toContain('agentic.reasoning.completed');
    expect(types).toContain('agentic.tool.authorized');
    expect(types).toContain('agentic.tool.started');
    expect(types).toContain('agentic.tool.completed');
    expect(types).toContain('agentic.loop.completed');
  });

  it('never reveals raw tool output in the tool call outcomes', async () => {
    const reasoning = new FakeReasoning()
      .then(
        JSON.stringify({ type: 'TOOL_CALL', tool: 'calculator', arguments: { expression: '1' } }),
      )
      .then(JSON.stringify({ type: 'FINAL_RESPONSE', response: 'ok' }));
    const tools = new FakeCoordinator();
    tools.plays(ToolResultStatus.Success, { secret: 'sensitive payload', result: 1 });
    const { loop } = makeLoop({ reasoning, tools });

    const result = await loop.run(runInput());
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('sensitive payload');

    const outcome = result.toolCalls[0];
    expect(outcome).toBeDefined();
    expect('output' in (outcome as unknown as Record<string, unknown>)).toBe(false);
  });

  it('records metrics totals for operation outcomes', async () => {
    const reasoning = new FakeReasoning()
      .then(
        JSON.stringify({ type: 'TOOL_CALL', tool: 'calculator', arguments: { expression: '1' } }),
      )
      .then(JSON.stringify({ type: 'FINAL_RESPONSE', response: 'ok' }));
    const tools = new FakeCoordinator();
    const { loop, metrics } = makeLoop({ reasoning, tools });

    await loop.run(runInput());

    const totals = metrics.snapshot().totals;
    expect(totals.operations).toBe(1);
    expect(totals.toolCalls).toBe(1);
    expect(totals.toolCallSuccesses).toBe(1);
    expect(totals.reasoningCalls).toBe(2);
    expect(totals.totalTokens).toBeGreaterThan(0);
  });
});
