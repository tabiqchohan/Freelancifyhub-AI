import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  ToolManagerService,
  ToolEventLog,
  ToolResultStatus,
  InMemoryToolRepository,
  ToolActorGroup,
  ToolSecurityLevel,
  ToolActorGroup as TG,
} from '../../../../src/agents/ag-004-tool-manager/index.js';
import { ToolConfigSchema } from '../../../../src/agents/ag-004-tool-manager/config/schema.js';
import {
  ToolAccessDeniedError,
  ToolStorageError,
} from '../../../../src/agents/ag-004-tool-manager/errors/index.js';
import { makeSpec } from './test-helpers.js';
import type {
  ToolActor,
  ToolExecutionContext,
  ToolHandler,
} from '../../../../src/agents/ag-004-tool-manager/types/index.js';

const config = ToolConfigSchema.parse({});
const ns = 'unit-tools';

const managerActor: ToolActor = {
  group: ToolActorGroup.ToolManager,
  id: 'mgr-1',
  namespaces: [ns],
  securityClearance: ToolSecurityLevel.Internal,
};

const execActor: ToolActor = {
  group: ToolActorGroup.Orchestrator,
  id: 'orch-1',
  namespaces: [ns],
  securityClearance: ToolSecurityLevel.Internal,
};

const noScopeActor: ToolActor = {
  group: ToolActorGroup.Orchestrator,
  id: 'orch-2',
  securityClearance: ToolSecurityLevel.Internal,
};

function makeService() {
  const repo = new InMemoryToolRepository();
  const events = new ToolEventLog();
  const service = new ToolManagerService({ repository: repo, config, eventLog: events });
  return { repo, events, service };
}

function execContext(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    actor: execActor,
    namespace: ns,
    traceId: 'trace-1',
    ...overrides,
  };
}

describe('AG-004 Tool Manager Service - registration + execution', () => {
  it('registers, executes, and returns a sanitized SUCCESS result', async () => {
    const { service } = makeService();
    const spec = makeSpec('double', '1.0.0', {
      inputSchema: z.object({ value: z.number() }),
      outputSchema: z.object({ doubled: z.number() }),
      handler: {
        name: 'double',
        invoke(input: unknown): unknown {
          const { value } = input as { value: number };
          return { doubled: value * 2 };
        },
      },
    });
    await service.register(spec, managerActor, ns);

    const result = await service.execute('double', { value: 21 }, execContext());
    expect(result.status).toBe(ToolResultStatus.Success);
    expect(result.toolName).toBe('double');
    expect(result.output).toEqual({ doubled: 42 });
    expect(result.attempts).toBe(1);
  });

  it('returns VALIDATION_FAILED on invalid input (no throw)', async () => {
    const { service } = makeService();
    await service.register(makeSpec('double', '1.0.0'), managerActor, ns);

    const result = await service.execute('double', { wrong: true } as never, execContext());
    expect(result.status).toBe(ToolResultStatus.ValidationFailed);
    expect(result.errorCode).toBe('TOOL_INPUT_VALIDATION_FAILED');
  });

  it('returns AUTHORIZATION_FAILED for an actor without namespace scope', async () => {
    const { service } = makeService();
    await service.register(makeSpec('double', '1.0.0'), managerActor, ns);

    const result = await service.execute(
      'double',
      { value: 1 },
      execContext({ actor: noScopeActor }),
    );
    expect(result.status).toBe(ToolResultStatus.AuthorizationFailed);
  });

  it('returns NOT_FOUND for an unknown tool', async () => {
    const { service } = makeService();
    const result = await service.execute('missing', {}, execContext());
    expect(result.status).toBe(ToolResultStatus.NotFound);
  });

  it('returns DISABLED when a tool is disabled', async () => {
    const { service } = makeService();
    await service.register(makeSpec('double', '1.0.0'), managerActor, ns);
    await service.disable('double', managerActor, ns);

    const result = await service.execute('double', { value: 1 }, execContext());
    expect(result.status).toBe(ToolResultStatus.Disabled);
  });

  it('management operations require ToolManager permission (enable)', async () => {
    const { service } = makeService();
    await service.register(makeSpec('double', '1.0.0'), managerActor, ns);

    await expect(service.disable('double', execActor, ns)).rejects.toBeInstanceOf(
      ToolAccessDeniedError,
    );
  });
});

describe('AG-004 Tool Executor - timeout, cancellation, retry', () => {
  function slowHandler(ms: number): ToolHandler {
    return {
      name: 'slow',
      invoke(): Promise<unknown> {
        return new Promise((resolve) => setTimeout(() => resolve({ ok: true }), ms));
      },
    };
  }

  it('times out a slow tool and reports TOOL_TIMEOUT (never false success)', async () => {
    const { service } = makeService();
    const spec = makeSpec('slow', '1.0.0', {
      handler: slowHandler(200),
      executionPolicy: {
        timeoutMs: 30,
        maxInputBytes: 1024,
        maxOutputBytes: 1024,
        retryPolicy: { maxRetries: 0, backoffBaseMs: 10, backoffMaxMs: 50 },
        securityLevel: ToolSecurityLevel.Internal,
      },
    });
    await service.register(spec, managerActor, ns);

    const result = await service.execute('slow', { value: 1 }, execContext());
    expect(result.status).toBe(ToolResultStatus.Timeout);
    expect(result.errorCode).toBe('TOOL_TIMEOUT');
  });

  it('respects cancellation signal and reports TOOL_CANCELLED', async () => {
    const { service } = makeService();
    await service.register(
      makeSpec('slow', '1.0.0', { handler: slowHandler(300) }),
      managerActor,
      ns,
    );

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const result = await service.execute(
      'slow',
      { value: 1 },
      execContext({ signal: controller.signal }),
    );
    expect(result.status).toBe(ToolResultStatus.Cancelled);
    expect(result.errorCode).toBe('TOOL_CANCELLED');
  });

  it('retries a retryable failure the configured number of times then fails', async () => {
    const { service } = makeService();
    const attempt = vi.fn();
    const handler: ToolHandler = {
      name: 'flaky',
      invoke(): unknown {
        attempt();
        throw new ToolStorageError('transient backend failure');
      },
    };
    const spec = makeSpec('flaky', '1.0.0', {
      handler,
      executionPolicy: {
        timeoutMs: 1000,
        maxInputBytes: 1024,
        maxOutputBytes: 1024,
        retryPolicy: { maxRetries: 2, backoffBaseMs: 2, backoffMaxMs: 8 },
        securityLevel: ToolSecurityLevel.Internal,
      },
    });
    await service.register(spec, managerActor, ns);

    const result = await service.execute('flaky', { value: 1 }, execContext());
    expect(result.status).toBe(ToolResultStatus.ExecutionFailed);
    expect(attempt).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
    expect(result.attempts).toBe(3);
  });

  it('succeeds on a later retry attempt', async () => {
    const { service } = makeService();
    let calls = 0;
    const handler: ToolHandler = {
      name: 'flaky2',
      invoke(): unknown {
        calls += 1;
        if (calls === 1) {
          throw new ToolStorageError('transient backend failure');
        }
        return { value: 42 };
      },
    };
    const spec = makeSpec('flaky2', '1.0.0', {
      handler,
      executionPolicy: {
        timeoutMs: 1000,
        maxInputBytes: 1024,
        maxOutputBytes: 1024,
        retryPolicy: { maxRetries: 2, backoffBaseMs: 2, backoffMaxMs: 8 },
        securityLevel: ToolSecurityLevel.Internal,
      },
    });
    await service.register(spec, managerActor, ns);

    const result = await service.execute('flaky2', { value: 1 }, execContext());
    expect(result.status).toBe(ToolResultStatus.Success);
    expect(calls).toBe(2);
    expect(result.attempts).toBe(2);
  });
});

describe('AG-004 Tool Manager Service - events & persistence', () => {
  it('emits registry events (registered, executing, succeeded)', async () => {
    const { service, events } = makeService();
    await service.register(makeSpec('double', '1.0.0'), managerActor, ns);
    await service.execute('double', { value: 5 }, execContext());

    const types = events.latest(10).map((e) => e.type);
    expect(types).toContain('tool.registered');
    expect(types).toContain('tool.execution.started');
    expect(types).toContain('tool.execution.succeeded');
  });

  it('persists a portable record to the in-memory repository', async () => {
    const { service, repo } = makeService();
    const def = await service.register(makeSpec('double', '1.0.0'), managerActor, ns);
    const record = await repo.getById(def.id);
    expect(record?.name).toBe('double');
    expect(record?.version).toBe('1.0.0');
    expect(record?.enabled).toBe(true);
  });

  it('register emits an authorization denial for non-manager actor', async () => {
    const { service } = makeService();
    await expect(
      service.register(makeSpec('double', '1.0.0'), execActor, ns),
    ).rejects.toBeInstanceOf(ToolAccessDeniedError);
  });
});

describe('AG-004 ActorGroups enum sanity', () => {
  it('exposes management and execution groups', () => {
    expect(TG.ToolManager).toBe('TOOL_MANAGER');
    expect(TG.Orchestrator).toBe('ORCHESTRATOR');
  });
});
