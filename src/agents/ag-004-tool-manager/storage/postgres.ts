import type pg from 'pg';
import type {
  ToolRecord,
  ToolRecordFilter,
  ToolRecordPage,
  ToolPagination,
} from '../repositories/types.js';
import type { ToolRepository } from '../repositories/interface.js';
import { ToolConflictError, ToolNotFoundError, ToolStorageError } from '../errors/index.js';
import { migrateToolSchema } from './schema.js';

/**
 * AG-004 PostgreSQL repository. Operates on the shared Neon pool alongside
 * AG-002's memory tables and AG-003's knowledge_* tables, using its own
 * tool_* tables. Uses parameterized SQL. Persists definitions/metadata only —
 * never executable JS/code, never secrets/credentials.
 */
export interface PostgresToolRepositoryOptions {
  readonly pool: pg.Pool;
}

function rowToRecord(row: Record<string, unknown>): ToolRecord {
  const parseJson = (value: unknown): unknown =>
    typeof value === 'string' ? JSON.parse(value as string) : value;
  return {
    id: String(row.id),
    name: String(row.name),
    description: String(row.description),
    version: String(row.version),
    category: String(row.category) as ToolRecord['category'],
    securityLevel: String(row.security_level) as ToolRecord['securityLevel'],
    permissions: (parseJson(row.permissions) ?? []) as ToolRecord['permissions'],
    executionPolicy: parseJson(row.execution_policy) as ToolRecord['executionPolicy'],
    enabled: Boolean(row.enabled),
    metadata: (parseJson(row.metadata) ?? {}) as ToolRecord['metadata'],
    createdAt:
      row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updatedAt:
      row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  };
}

export class PostgresToolRepository implements ToolRepository {
  readonly name = 'postgres-tool-repository';
  private readonly pool: pg.Pool;

  constructor(options: PostgresToolRepositoryOptions) {
    this.pool = options.pool;
  }

  get poolForRepository(): pg.Pool {
    return this.pool;
  }

  /** Apply tool schema migrations. */
  async migrate(): Promise<number> {
    return migrateToolSchema(this.pool);
  }

  async save(record: ToolRecord): Promise<ToolRecord> {
    const sql = `INSERT INTO tool_definitions
      (id, name, description, version, category, security_level, permissions, execution_policy, enabled, metadata, created_at, updated_at, namespace)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      RETURNING *`;
    const params = [
      record.id,
      record.name,
      record.description,
      record.version,
      record.category,
      record.securityLevel,
      JSON.stringify(record.permissions),
      JSON.stringify(record.executionPolicy),
      record.enabled,
      JSON.stringify(record.metadata),
      record.createdAt,
      record.updatedAt,
      'default',
    ];
    try {
      const res = await this.pool.query(sql, params);
      return rowToRecord(res.rows[0] as Record<string, unknown>);
    } catch (err: unknown) {
      const error = err as { code?: string; constraint?: string };
      if (error.code === '23505' || (error.constraint ?? '').includes('name_version')) {
        throw new ToolConflictError(`Tool ${record.id} already exists`, {
          details: { id: record.id },
        });
      }
      throw new ToolStorageError('Failed to save tool definition', { cause: err });
    }
  }

  async update(record: ToolRecord): Promise<ToolRecord> {
    const sql = `UPDATE tool_definitions SET
      name = $2, description = $3, version = $4, category = $5, security_level = $6,
      permissions = $7, execution_policy = $8, enabled = $9, metadata = $10, updated_at = $11
      WHERE id = $1 RETURNING *`;
    const params = [
      record.id,
      record.name,
      record.description,
      record.version,
      record.category,
      record.securityLevel,
      JSON.stringify(record.permissions),
      JSON.stringify(record.executionPolicy),
      record.enabled,
      JSON.stringify(record.metadata),
      record.updatedAt,
    ];
    try {
      const res = await this.pool.query(sql, params);
      if (res.rows.length === 0) {
        throw new ToolNotFoundError(`Tool ${record.id} not found`, { details: { id: record.id } });
      }
      return rowToRecord(res.rows[0] as Record<string, unknown>);
    } catch (err) {
      if (err instanceof ToolNotFoundError) {
        throw err;
      }
      const error = err as { code?: string };
      if (error.code === '23505') {
        throw new ToolConflictError(`Tool ${record.id} version conflict`, {
          details: { id: record.id },
        });
      }
      throw new ToolStorageError('Failed to update tool definition', { cause: err });
    }
  }

  async getById(id: string): Promise<ToolRecord | undefined> {
    const res = await this.pool.query<Record<string, unknown>>(
      'SELECT * FROM tool_definitions WHERE id = $1',
      [id],
    );
    if (res.rows.length === 0) return undefined;
    return rowToRecord(res.rows[0]!);
  }

  async list(
    filter: ToolRecordFilter = {},
    pagination: ToolPagination = { offset: 0, limit: 50 },
  ): Promise<ToolRecordPage> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.name !== undefined) {
      params.push(filter.name);
      conditions.push(`name = $${params.length}`);
    }
    if (filter.category !== undefined) {
      params.push(filter.category);
      conditions.push(`category = $${params.length}`);
    }
    if (filter.enabled !== undefined) {
      params.push(filter.enabled);
      conditions.push(`enabled = $${params.length}`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sortBy = pagination.sortBy ?? 'created_at';
    const sortDir = pagination.sortDirection ?? 'asc';
    const orderClause = `ORDER BY ${sortBy} ${sortDir} NULLS LAST, id ASC`;

    const countRes = await this.pool.query<{ count: string | number }>(
      `SELECT count(*)::bigint as count FROM tool_definitions ${whereClause}`,
      params,
    );
    const total = Number(countRes.rows[0]?.count ?? 0);

    const limit = Math.max(1, Math.min(pagination.limit, 100));
    const offset = Math.max(0, pagination.offset);

    const dataRes = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM tool_definitions ${whereClause} ${orderClause} LIMIT ${limit} OFFSET ${offset}`,
      params,
    );

    return {
      items: dataRes.rows.map((r) => rowToRecord(r)),
      total,
      offset,
      limit,
      hasMore: offset + limit < total,
    };
  }

  async remove(id: string): Promise<boolean> {
    const res = await this.pool.query('DELETE FROM tool_definitions WHERE id = $1 RETURNING id', [
      id,
    ]);
    return (res.rowCount ?? 0) > 0;
  }

  async healthAsync(): Promise<{ healthy: boolean; message: string }> {
    try {
      await this.pool.query('SELECT 1');
      return {
        healthy: true,
        message: 'tool repository healthy',
      };
    } catch {
      return { healthy: false, message: 'tool repository unavailable' };
    }
  }

  async clear(): Promise<void> {
    await this.pool.query('DELETE FROM tool_definitions');
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
