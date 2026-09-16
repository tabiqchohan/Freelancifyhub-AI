import { describe, expect, it } from 'vitest';

import { AggregationStatus } from '../../../src/agents/ag-001-master-orchestrator/aggregation/index.js';
import { RuleBasedIntentClassifier } from '../../../src/agents/ag-001-master-orchestrator/intent/index.js';
import { RequestActorRegistry } from '../../../src/app/request-actors.js';
import { DEFAULT_AIOS_CONFIG } from '../../../src/ai-operating-system/config.js';
import { AiosErrorCode } from '../../../src/ai-operating-system/errors.js';
import { AiosEventLog } from '../../../src/ai-operating-system/events.js';
import { createDefaultPolicy } from '../../../src/ai-operating-system/policy.js';
import { AiosPipeline } from '../../../src/ai-operating-system/pipeline.js';
import { AiosMetrics } from '../../../src/ai-operating-system/metrics.js';
import type { ExecutionCatcher } from '../../../src/ai-operating-system/execution-result.js';
import type { ExecutionContext } from '../../../src/ai-operating-system/execution-context.js';
import type { AiosService } from '../../../src/ai-operating-system/service.js';
import type { AiosPipelineInput } from '../../../src/ai-operating-system/pipeline.js';
import { AiosStage, type AiosActor } from '../../../src/ai-operating-system/types.js';

const classifier = new RuleBasedIntentClassifier();

function stubService(): AiosService {
  const dispatch = async (_ctx: unknown, exec: ExecutionContext): Promise<ExecutionCatcher> => ({
    target: exec.target,
    status: AggregationStatus.Success,
    responseText: 'Work completed by the owning team.',
    agents: ['AG-101'],
    confidence: 0.95,
    startedAtMs: exec.startedAtMs,
    completedAtMs: Date.now(),
  });
  return { dispatch } as unknown as AiosService;
}

function buildPipeline(config = DEFAULT_AIOS_CONFIG) {
  return new AiosPipeline({
    config,
    classifier,
    requestActors: new RequestActorRegistry(),
    policy: createDefaultPolicy(),
    service: stubService(),
    eventLog: new AiosEventLog(),
    metrics: new AiosMetrics(),
  });
}

function input(
  text: string,
  role: string,
  overrides: Partial<AiosPipelineInput> = {},
): AiosPipelineInput {
  const actor: AiosActor = { actorId: 'u-1', role: role as never, namespaces: ['community'] };
  return {
    requestId: `req-${Math.random().toString(36).slice(2, 10)}`,
    traceId: 'trace-1',
    actor,
    input: { text },
    ...overrides,
  };
}

describe('AIOS pipeline phase chain (Sprint 26)', () => {
  it('runs the full client route to SUCCESS with the complete stage list', async () => {
    const pipeline = buildPipeline();
    const response = await pipeline.execute(input('create project new website', 'Freelancer'));
    expect(response.intent).toBe('project.create');
    expect(response.status).toBe(AggregationStatus.Success);
    expect(response.execution.target).toEqual({ kind: 'client' });
    expect(response.stages[0]).toBe(AiosStage.Validate);
    expect(response.stages.at(-1)).toBe(AiosStage.FinalizeResponse);
    expect(response.stages.length).toBeGreaterThanOrEqual(12);
  });

  it('routes admin intents to the admin tail', async () => {
    const pipeline = buildPipeline();
    const response = await pipeline.execute(input('analytics query platform trend', 'Admin'));
    expect(response.intent).toBe('admin.analytics');
    expect(response.execution.target).toEqual({ kind: 'admin' });
  });

  it('throws UnknownIntent fail-closed on undetectable text', async () => {
    const pipeline = buildPipeline();
    await expect(
      pipeline.execute(input('flibbertigibbet zyzzy', 'Freelancer')),
    ).rejects.toMatchObject({
      code: AiosErrorCode.UnknownIntent,
    });
  });

  it('throws SecretDetected when inbound text carries a secret shape', async () => {
    const pipeline = buildPipeline();
    await expect(
      pipeline.execute(input('create a new project key sk-ABCDEFGHIJKLMNOPQRST', 'Freelancer')),
    ).rejects.toMatchObject({ code: AiosErrorCode.SecretDetected });
  });

  it('throws UnauthorizedScope fail-closed for a Guest reaching project features', async () => {
    const pipeline = buildPipeline();
    await expect(pipeline.execute(input('view project', 'Guest'))).rejects.toMatchObject({
      code: AiosErrorCode.UnauthorizedScope,
    });
  });

  it('injects a probe event when the caller opts into observability', async () => {
    const eventLog = new AiosEventLog();
    const pipeline = new AiosPipeline({
      config: DEFAULT_AIOS_CONFIG,
      classifier,
      requestActors: new RequestActorRegistry(),
      policy: createDefaultPolicy(),
      service: stubService(),
      eventLog,
      metrics: new AiosMetrics(),
    });
    const request = input('create project new website', 'Freelancer', {
      options: { metadata: { aiosProbe: true } },
    });
    await pipeline.execute(request);
    expect(eventLog.probeFor(request.requestId)).toBeDefined();
    expect(eventLog.eventsFor(request.requestId).some((e) => e.type === 'aios.probe')).toBe(true);
  });
});
