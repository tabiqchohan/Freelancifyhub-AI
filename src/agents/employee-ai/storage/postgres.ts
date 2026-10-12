import type pg from 'pg';
import type { EmployeeTaskRepository } from './interface.js';
import type { EmployeeArtifactBytes, EmployeeTaskRecord } from './types.js';
import type { EmployeePhaseValue, EmployeeResult } from '../types.js';
import { migrateEmployeeSchema } from './schema.js';

/**
 * Prompts19 Phase 2 — PostgreSQL implementation of {@link EmployeeTaskRepository}.
 *
 * Persists task state and the reviewed ZIP bytes so status/artifact survive a
 * process restart. Uses parameterized SQL and only ever stores the bounded
 * {@link EmployeeResult} DTO plus identifiers — no secrets, tokens or credentials.
 */
export interface PostgresEmployeeTaskRepositoryOptions {
  readonly pool: pg.Pool;
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') return Number.parseInt(value, 10);
  return 0;
}

function parseJson(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function rowToRecord(row: Record<string, unknown>): EmployeeTaskRecord {
  return {
    taskId: String(row.task_id),
    projectId: String(row.project_id),
    clientId: String(row.client_id),
    requestText: String(row.request_text),
    requestId: String(row.request_id),
    traceId: String(row.trace_id),
    phase: String(row.phase) as EmployeePhaseValue,
    result: parseJson(row.result) as EmployeeResult,
    artifactFileName: row.artifact_file_name == null ? undefined : String(row.artifact_file_name),
    artifactSha256: row.artifact_sha256 == null ? undefined : String(row.artifact_sha256),
    artifactPath: row.artifact_path == null ? undefined : String(row.artifact_path),
    startedAt: toNumber(row.started_at),
    completedAt: row.completed_at == null ? undefined : toNumber(row.completed_at),
    updatedAt: toNumber(row.updated_at),
    expiresAt: toNumber(row.expires_at),
  };
}

export class PostgresEmployeeTaskRepository implements EmployeeTaskRepository {
  readonly durable = true;
  private readonly pool: pg.Pool;

  constructor(options: PostgresEmployeeTaskRepositoryOptions) {
    this.pool = options.pool;
  }

  get poolForRepository(): pg.Pool {
    return this.pool;
  }

  async migrate(): Promise<void> {
    await migrateEmployeeSchema(this.pool);
  }

  async saveTask(record: EmployeeTaskRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO employee_tasks
        (task_id, project_id, client_id, request_text, request_id, trace_id, phase, result,
         artifact_file_name, artifact_sha256, artifact_path, started_at, completed_at, updated_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (task_id) DO UPDATE SET
         phase = EXCLUDED.phase,
         result = EXCLUDED.result,
         artifact_file_name = EXCLUDED.artifact_file_name,
         artifact_sha256 = EXCLUDED.artifact_sha256,
         artifact_path = EXCLUDED.artifact_path,
         completed_at = EXCLUDED.completed_at,
         updated_at = EXCLUDED.updated_at,
         expires_at = EXCLUDED.expires_at`,
      [
        record.taskId,
        record.projectId,
        record.clientId,
        record.requestText,
        record.requestId,
        record.traceId,
        record.phase,
        JSON.stringify(record.result),
        record.artifactFileName ?? null,
        record.artifactSha256 ?? null,
        record.artifactPath ?? null,
        record.startedAt,
        record.completedAt ?? null,
        record.updatedAt,
        record.expiresAt,
      ],
    );
  }

  async getTask(taskId: string): Promise<EmployeeTaskRecord | undefined> {
    const res = await this.pool.query<Record<string, unknown>>(
      'SELECT * FROM employee_tasks WHERE task_id = $1',
      [taskId],
    );
    return res.rows.length === 0 ? undefined : rowToRecord(res.rows[0]!);
  }

  async listTasks(limit = 200): Promise<EmployeeTaskRecord[]> {
    const bounded = Math.max(0, Math.min(limit, 1000));
    const res = await this.pool.query<Record<string, unknown>>(
      'SELECT * FROM employee_tasks ORDER BY updated_at DESC LIMIT $1',
      [bounded],
    );
    return res.rows.map(rowToRecord);
  }

  async listNonTerminal(): Promise<EmployeeTaskRecord[]> {
    const res = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM employee_tasks
        WHERE phase NOT IN ('READY_FOR_REVIEW','FAILED','CANCELED','TIMED_OUT')
        ORDER BY updated_at ASC`,
    );
    return res.rows.map(rowToRecord);
  }

  async deleteTask(taskId: string): Promise<void> {
    await this.pool.query('DELETE FROM employee_tasks WHERE task_id = $1', [taskId]);
  }

  async saveArtifact(
    taskId: string,
    artifact: EmployeeArtifactBytes,
    expiresAt: number,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO employee_artifacts (task_id, file_name, sha256, size_bytes, content, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (task_id) DO UPDATE SET
         file_name = EXCLUDED.file_name,
         sha256 = EXCLUDED.sha256,
         size_bytes = EXCLUDED.size_bytes,
         content = EXCLUDED.content,
         expires_at = EXCLUDED.expires_at`,
      [
        taskId,
        artifact.fileName,
        artifact.sha256,
        artifact.bytes.byteLength,
        artifact.bytes,
        expiresAt,
      ],
    );
  }

  async getArtifact(taskId: string): Promise<EmployeeArtifactBytes | undefined> {
    const res = await this.pool.query<Record<string, unknown>>(
      'SELECT file_name, sha256, content FROM employee_artifacts WHERE task_id = $1',
      [taskId],
    );
    if (res.rows.length === 0) return undefined;
    const row = res.rows[0]!;
    const content = row.content;
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content as Uint8Array | string);
    return { fileName: String(row.file_name), sha256: String(row.sha256), bytes };
  }

  async deleteArtifact(taskId: string): Promise<void> {
    await this.pool.query('DELETE FROM employee_artifacts WHERE task_id = $1', [taskId]);
  }

  async reap(now: number): Promise<EmployeeTaskRecord[]> {
    await this.pool.query('DELETE FROM employee_artifacts WHERE expires_at <= $1', [now]);
    const res = await this.pool.query<Record<string, unknown>>(
      'DELETE FROM employee_tasks WHERE expires_at <= $1 RETURNING *',
      [now],
    );
    return res.rows.map(rowToRecord);
  }

  async health(): Promise<{ healthy: boolean; message: string }> {
    try {
      await this.pool.query('SELECT 1');
      return { healthy: true, message: 'employee repository healthy' };
    } catch {
      return { healthy: false, message: 'employee repository unavailable' };
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
