import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type pg from 'pg';

import { resolveTestDatabase } from '../../../src/lib/test-database-guard.js';
import { createPostgresPool } from '../../../src/agents/ag-002-memory-manager/index.js';
import { PostgresEmployeeTaskRepository } from '../../../src/agents/employee-ai/storage/postgres.js';
import { EmployeePhase, type EmployeeResult } from '../../../src/agents/employee-ai/types.js';

/**
 * Prompts19 Phase 2 — real PostgreSQL integration tests for the AI Employee
 * durable task/artifact store.
 *
 * Runs ONLY when AIOS_TEST_DATABASE_URL is configured (isolated local test DB;
 * never falls back to the production MEMORY_DATABASE_URL). Exercises genuine
 * durable behaviour: schema migrations (300+), task round-trip, artifact byte
 * round-trip with integrity metadata, restart durability over a fresh repository,
 * interrupted-task listing and TTL reaping.
 */

const testDb = resolveTestDatabase('AI Employee durable storage integration suite');
const DATABASE_URL = testDb.url;

const suite = testDb.enabled ? describe : describe.skip;

const ns = `int-emp-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

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

suite('Employee - real PostgreSQL durable backend (integration)', () => {
  let pool: pg.Pool;
  let repo: PostgresEmployeeTaskRepository;
  const created: string[] = [];

  const record = (taskId: string, overrides: Record<string, unknown> = {}) => {
    const now = Date.now();
    created.push(taskId);
    return {
      taskId,
      projectId: `project-${ns}`,
      clientId: `client-${ns}`,
      requestText: 'a portfolio website with an about page',
      requestId: `req-${taskId}`,
      traceId: `trace-${taskId}`,
      phase: EmployeePhase.READY_FOR_REVIEW,
      result: result(),
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      expiresAt: now + 60_000,
      ...overrides,
    };
  };

  beforeAll(async () => {
    pool = createPostgresPool(DATABASE_URL!);
    repo = new PostgresEmployeeTaskRepository({ pool });
    await repo.migrate();
  }, 120000);

  afterAll(async () => {
    if (pool) {
      for (const taskId of created) {
        await pool
          .query('DELETE FROM employee_artifacts WHERE task_id = $1', [taskId])
          .catch(() => undefined);
        await pool
          .query('DELETE FROM employee_tasks WHERE task_id = $1', [taskId])
          .catch(() => undefined);
      }
      await pool.end().catch(() => undefined);
    }
  });

  it('applies employee schema migrations (300+) under the shared lock', async () => {
    const res = await pool.query<{ version: number }>(
      'SELECT version FROM schema_migrations WHERE version IN (300, 301) ORDER BY version',
    );
    expect(res.rows.map((r) => Number(r.version))).toEqual([300, 301]);
  });

  it('persists and reads back a terminal task record', async () => {
    const taskId = `emp-${ns}-roundtrip`;
    await repo.saveTask(record(taskId));
    const stored = await repo.getTask(taskId);
    expect(record(taskId)).toBeDefined();
    expect(stored?.phase).toBe(EmployeePhase.READY_FOR_REVIEW);
    expect(stored?.result.toolCalls).toBe(5);
  });

  it('persists artifact bytes with integrity metadata and survives a re-open', async () => {
    const taskId = `emp-${ns}-artifact`;
    const bytes = Buffer.from('PK\x03\x04durable-payload');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    await repo.saveTask(record(taskId, { artifactFileName: 'bundle.zip', artifactSha256: sha256 }));
    await repo.saveArtifact(taskId, { fileName: 'bundle.zip', sha256, bytes }, Date.now() + 60_000);

    // Re-open a fresh repository over the same pool to simulate a restart.
    const fresh = new PostgresEmployeeTaskRepository({ pool });
    const restored = await fresh.getTask(taskId);
    expect(restored?.artifactFileName).toBe('bundle.zip');
    const artifact = await fresh.getArtifact(taskId);
    expect(artifact?.bytes.equals(bytes)).toBe(true);
    expect(artifact?.sha256).toBe(sha256);
  });

  it('detects non-terminal (interrupted) tasks for restart recovery', async () => {
    const taskId = 'emp-' + ns + '-stuck';
    await repo.saveTask(
      record(taskId, {
        phase: EmployeePhase.EXECUTING,
        result: result({ phase: EmployeePhase.EXECUTING, status: EmployeePhase.EXECUTING }),
        completedAt: undefined,
      }),
    );
    const stuck = await repo.listNonTerminal();
    expect(stuck.some((r) => r.taskId === taskId)).toBe(true);
  });

  it('reaps expired tasks and artifacts and returns the evicted records', async () => {
    const taskId = 'emp-' + ns + '-expired';
    await repo.saveTask(record(taskId, { expiresAt: Date.now() - 1 }));
    await repo.saveArtifact(
      taskId,
      { fileName: 'gone.zip', sha256: 'h', bytes: Buffer.from('gone') },
      Date.now() - 1,
    );
    const evicted = await repo.reap(Date.now());
    expect(evicted.some((r) => r.taskId === taskId)).toBe(true);
    expect(await repo.getTask(taskId)).toBeUndefined();
    expect(await repo.getArtifact(taskId)).toBeUndefined();
  });

  it('is healthy over a live connection', async () => {
    expect((await repo.health()).healthy).toBe(true);
  });
});
