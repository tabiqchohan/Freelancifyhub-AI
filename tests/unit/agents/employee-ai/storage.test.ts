import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_EMPLOYEE_CONFIG,
  resolveEmployeeStorageBackend,
} from '../../../../src/agents/employee-ai/config.js';
import { EmployeeErrorCode } from '../../../../src/agents/employee-ai/errors.js';
import type {
  EmployeeExecutor,
  EmployeeExecutionResult,
} from '../../../../src/agents/employee-ai/execution.js';
import type { EmployeeEventSink } from '../../../../src/agents/employee-ai/events.js';
import { InMemoryEmployeeTaskRepository } from '../../../../src/agents/employee-ai/storage/in-memory.js';
import { EmployeeReaper } from '../../../../src/agents/employee-ai/reaper.js';
import { EmployeeService } from '../../../../src/agents/employee-ai/service.js';
import {
  EmployeePhase,
  type EmployeeResult,
  type WebsiteTaskInput,
} from '../../../../src/agents/employee-ai/types.js';

/**
 * Prompts19 Phase 2/4 — AI Employee production-hardening unit suite.
 *
 *   EMP-STORE-* : durable repository + write-through persistence + hydration.
 *   EMP-QUOTA-* : bounded concurrency, queue capacity and per-client limits.
 *   EMP-REAP-*  : TTL reaping of records, artifacts and workspaces.
 */

const sink: EmployeeEventSink = { emit: () => undefined };

let tempDirs: string[] = [];
async function makeRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'emp-store-'));
  tempDirs.push(dir);
  return dir;
}
beforeEach(() => {
  tempDirs = [];
});
afterEach(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => undefined)),
  );
});

const INPUT: WebsiteTaskInput = {
  taskId: 'task-x',
  projectId: 'project-1',
  clientId: 'client-1',
  requestText: 'a portfolio website with an about page',
};

function result(overrides: Partial<EmployeeResult> = {}): EmployeeResult {
  return {
    phase: EmployeePhase.READY_FOR_REVIEW,
    status: EmployeePhase.READY_FOR_REVIEW,
    summary: 'done',
    filesCreated: 1,
    bytesWritten: 10,
    repairAttempts: 0,
    toolCalls: 5,
    warnings: [],
    nextActions: [],
    durationMs: 1,
    ...overrides,
  };
}

interface ControllableExecutor {
  readonly executor: EmployeeExecutor;
  resolveNext(result: EmployeeExecutionResult): void;
  resolveFor(taskId: string, result: EmployeeExecutionResult): void;
  remaining(): number;
}

/** A stub executor whose tasks complete only when the test resolves them. */
function controllableExecutor(opts: { honorAbort?: boolean } = {}): ControllableExecutor {
  const pending = new Map<string, (r: EmployeeExecutionResult) => void>();
  const executor = {
    async executeTask(
      input: WebsiteTaskInput,
      _requestId: string,
      _traceId: string,
      signal: AbortSignal,
    ): Promise<EmployeeExecutionResult> {
      return new Promise<EmployeeExecutionResult>((resolve) => {
        pending.set(input.taskId, resolve);
        if (opts.honorAbort === true) {
          signal.addEventListener('abort', () =>
            resolve({
              result: result({ phase: EmployeePhase.CANCELED, status: EmployeePhase.CANCELED }),
            }),
          );
        }
      });
    },
  };
  return {
    executor: executor as unknown as EmployeeExecutor,
    resolveNext(r) {
      const key = pending.keys().next().value as string | undefined;
      if (key === undefined) throw new Error('no pending task to resolve');
      const fn = pending.get(key)!;
      pending.delete(key);
      fn(r);
    },
    resolveFor(taskId, r) {
      const fn = pending.get(taskId);
      if (fn === undefined) throw new Error(`no pending task ${taskId}`);
      pending.delete(taskId);
      fn(r);
    },
    remaining: () => pending.size,
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('EMP-STORE-1 in-memory repository semantics', () => {
  it('round-trips task records and artifacts, and reaps expired rows', async () => {
    const repo = new InMemoryEmployeeTaskRepository();
    expect(repo.durable).toBe(false);
    const now = Date.now();
    await repo.saveTask({
      ...INPUT,
      requestId: 'r',
      traceId: 't',
      phase: EmployeePhase.READY_FOR_REVIEW,
      result: result(),
      artifactFileName: 'bundle.zip',
      artifactSha256: 'abc',
      artifactPath: '/tmp/bundle.zip',
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      expiresAt: now + 1000,
    });
    await repo.saveArtifact(
      'task-x',
      { fileName: 'bundle.zip', sha256: 'abc', bytes: Buffer.from('pk') },
      now + 1000,
    );

    expect((await repo.getTask('task-x'))?.phase).toBe(EmployeePhase.READY_FOR_REVIEW);
    expect((await repo.getArtifact('task-x'))?.bytes.toString()).toBe('pk');
    expect(await repo.listNonTerminal()).toHaveLength(0);

    expect(await repo.reap(now + 2000)).toHaveLength(1);
    expect(await repo.getTask('task-x')).toBeUndefined();
    expect(await repo.getArtifact('task-x')).toBeUndefined();
  });
});

describe('EMP-STORE-2 write-through persistence and hydration', () => {
  it('persists accepted + terminal state and the reviewed artifact', async () => {
    const root = await makeRoot();
    const artifactPath = join(root, 'bundle.zip');
    await writeFile(artifactPath, Buffer.from('PK\x03\x04payload'));
    const repo = new InMemoryEmployeeTaskRepository();
    const control = controllableExecutor();
    const service = new EmployeeService(DEFAULT_EMPLOYEE_CONFIG, control.executor, sink, repo);

    const run = await service.execute({
      projectId: 'project-1',
      clientId: 'client-1',
      requestText: INPUT.requestText,
      requestId: 'r-1',
    });
    control.resolveNext({
      result: result({ artifact: { fileName: 'bundle.zip', sizeBytes: 12, sha256: 'sha' } }),
      artifactPath,
    });
    await waitUntil(() => service.status(run.taskId).status === EmployeePhase.READY_FOR_REVIEW);

    const stored = await repo.getTask(run.taskId);
    expect(stored?.phase).toBe(EmployeePhase.READY_FOR_REVIEW);
    expect(await repo.getArtifact(run.taskId)).toBeDefined();

    const payload = await service.artifact(run.taskId, 'project-1', 'client-1');
    expect(payload?.fileName).toContain('bundle.zip');
    expect(Buffer.from(payload!.base64, 'base64').toString()).toBe('PK\x03\x04payload');
    expect(run.taskId.startsWith('emp-')).toBe(true);
  });

  it('marks non-terminal tasks FAILED on hydrate and keeps terminal artifacts', async () => {
    const repo = new InMemoryEmployeeTaskRepository();
    const now = Date.now();
    await repo.saveTask({
      ...INPUT,
      taskId: 'emp-stuck',
      requestId: 'r',
      traceId: 't',
      phase: EmployeePhase.EXECUTING,
      result: result({ phase: EmployeePhase.EXECUTING, status: EmployeePhase.EXECUTING }),
      startedAt: now,
      updatedAt: now,
      expiresAt: now + 60_000,
    });
    await repo.saveTask({
      ...INPUT,
      taskId: 'emp-done',
      requestId: 'r2',
      traceId: 't2',
      phase: EmployeePhase.READY_FOR_REVIEW,
      result: result(),
      artifactFileName: 'b.zip',
      artifactSha256: 'h',
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      expiresAt: now + 60_000,
    });

    const service = new EmployeeService(
      DEFAULT_EMPLOYEE_CONFIG,
      controllableExecutor().executor,
      sink,
      repo,
    );
    await service.hydrate();

    expect(service.status('emp-stuck').status).toBe(EmployeePhase.FAILED);
    expect((await repo.getTask('emp-stuck'))?.phase).toBe(EmployeePhase.FAILED);
    expect(service.status('emp-done').status).toBe(EmployeePhase.READY_FOR_REVIEW);
  });

  it('serves hydrated artifacts from durable bytes after a restart', async () => {
    const repo = new InMemoryEmployeeTaskRepository();
    const now = Date.now();
    await repo.saveTask({
      ...INPUT,
      taskId: 'emp-persist',
      requestId: 'r',
      traceId: 't',
      phase: EmployeePhase.READY_FOR_REVIEW,
      result: result({ artifact: { fileName: 'b.zip', sizeBytes: 2, sha256: 'h' } }),
      artifactFileName: 'b.zip',
      artifactSha256: 'h',
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      expiresAt: now + 60_000,
    });
    await repo.saveArtifact(
      'emp-persist',
      { fileName: 'b.zip', sha256: 'h', bytes: Buffer.from('PK') },
      now + 60_000,
    );

    const service = new EmployeeService(
      DEFAULT_EMPLOYEE_CONFIG,
      controllableExecutor().executor,
      sink,
      repo,
    );
    await service.hydrate();
    const artifact = await service.artifact('emp-persist', INPUT.projectId, INPUT.clientId);
    expect(artifact?.fileName).toBe('b.zip');
    expect(Buffer.from(artifact!.base64, 'base64').toString()).toBe('PK');
  });
});

describe('EMP-QUOTA-1 bounded concurrency and backpressure', () => {
  it('rejects a second task for the same client while one is in flight', async () => {
    const config = {
      ...DEFAULT_EMPLOYEE_CONFIG,
      EMPLOYEE_MAX_ACTIVE_TASKS: 1,
      EMPLOYEE_MAX_USER_ACTIVE_TASKS: 1,
      EMPLOYEE_QUEUE_CAPACITY: 0,
    };
    const control = controllableExecutor();
    const service = new EmployeeService(
      config,
      control.executor,
      sink,
      new InMemoryEmployeeTaskRepository(),
    );
    await service.execute({
      projectId: 'p',
      clientId: 'c1',
      requestText: INPUT.requestText,
      requestId: 'r1',
    });
    await expect(
      service.execute({
        projectId: 'p',
        clientId: 'c1',
        requestText: INPUT.requestText,
        requestId: 'r2',
      }),
    ).rejects.toMatchObject({ code: EmployeeErrorCode.RESOURCE_LIMIT });
  });

  it('rejects globally when concurrency and queue capacity are exhausted', async () => {
    const config = {
      ...DEFAULT_EMPLOYEE_CONFIG,
      EMPLOYEE_MAX_ACTIVE_TASKS: 1,
      EMPLOYEE_MAX_USER_ACTIVE_TASKS: 10,
      EMPLOYEE_QUEUE_CAPACITY: 0,
    };
    const control = controllableExecutor();
    const service = new EmployeeService(
      config,
      control.executor,
      sink,
      new InMemoryEmployeeTaskRepository(),
    );
    await service.execute({
      projectId: 'p',
      clientId: 'c1',
      requestText: INPUT.requestText,
      requestId: 'r1',
    });
    await expect(
      service.execute({
        projectId: 'p',
        clientId: 'c2',
        requestText: INPUT.requestText,
        requestId: 'r2',
      }),
    ).rejects.toMatchObject({ code: EmployeeErrorCode.RESOURCE_LIMIT });
  });

  it('queues up to capacity and drains as slots free', async () => {
    const config = {
      ...DEFAULT_EMPLOYEE_CONFIG,
      EMPLOYEE_MAX_ACTIVE_TASKS: 1,
      EMPLOYEE_MAX_USER_ACTIVE_TASKS: 5,
      EMPLOYEE_QUEUE_CAPACITY: 1,
    };
    const control = controllableExecutor();
    const service = new EmployeeService(
      config,
      control.executor,
      sink,
      new InMemoryEmployeeTaskRepository(),
    );
    const first = await service.execute({
      projectId: 'p',
      clientId: 'c1',
      requestText: INPUT.requestText,
      requestId: 'r1',
    });
    const second = await service.execute({
      projectId: 'p',
      clientId: 'c1',
      requestText: INPUT.requestText,
      requestId: 'r2',
    });
    // Only one executes at a time; the second is queued.
    expect(control.remaining()).toBe(1);
    expect(service.activeCount()).toBe(1);

    control.resolveFor(first.taskId, {
      result: result({ phase: EmployeePhase.FAILED, status: EmployeePhase.FAILED }),
    });
    await waitUntil(() => control.remaining() === 1 && service.activeCount() === 1);
    control.resolveFor(second.taskId, { result: result() });
    await waitUntil(() => service.status(second.taskId).status === EmployeePhase.READY_FOR_REVIEW);
  });
});

describe('EMP-REAP-1 TTL reaping removes records, artifacts and workspaces', () => {
  it('sweeps expired tasks and their workspace directories', async () => {
    const root = await makeRoot();
    const repo = new InMemoryEmployeeTaskRepository();
    const now = Date.now();
    const workspace = join(root, INPUT.projectId, 'emp-old');
    await writeFile(join(root, 'placeholder'), 'x');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, 'index.html'), 'hi');
    await repo.saveTask({
      ...INPUT,
      taskId: 'emp-old',
      requestId: 'r',
      traceId: 't',
      phase: EmployeePhase.READY_FOR_REVIEW,
      result: result(),
      startedAt: now - 1000,
      completedAt: now - 1000,
      updatedAt: now - 1000,
      expiresAt: now - 1,
    });

    const reaper = new EmployeeReaper({
      repository: repo,
      workspacesRoot: root,
      intervalMs: 10_000,
    });
    const swept = await reaper.sweep();
    expect(swept).toBe(1);
    expect(await repo.getTask('emp-old')).toBeUndefined();
    await expect(readFile(join(workspace, 'index.html'))).rejects.toBeDefined();
  });
});

describe('EMP-STORE-3 storage backend resolution', () => {
  it('defaults to in-memory in dev/test and durable in production', () => {
    expect(resolveEmployeeStorageBackend(DEFAULT_EMPLOYEE_CONFIG, 'test')).toBe('in-memory');
    expect(resolveEmployeeStorageBackend(DEFAULT_EMPLOYEE_CONFIG, 'development')).toBe('in-memory');
    expect(resolveEmployeeStorageBackend(DEFAULT_EMPLOYEE_CONFIG, 'production')).toBe('durable');
  });
  it('rejects an explicit in-memory backend in production (fail-closed)', () => {
    expect(() =>
      resolveEmployeeStorageBackend(
        { ...DEFAULT_EMPLOYEE_CONFIG, EMPLOYEE_STORAGE_BACKEND: 'in-memory' },
        'production',
      ),
    ).toThrow(/not allowed in production/);
  });
});
