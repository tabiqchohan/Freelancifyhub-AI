import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';

import {
  ToolManagerService,
  PostgresToolRepository,
  ToolActorGroup,
  ToolSecurityLevel,
  ToolCategory,
  ToolEventLog,
  createCalculatorSpecification,
} from '../../../src/agents/ag-004-tool-manager/index.js';
import { ToolConfigSchema } from '../../../src/agents/ag-004-tool-manager/config/schema.js';
import { createPostgresPool } from '../../../src/agents/ag-002-memory-manager/index.js';
import type {
  ToolActor,
  ToolSpecification,
} from '../../../src/agents/ag-004-tool-manager/types/index.js';

/**
 * AG-004 real PostgreSQL (Neon) integration tests.
 *
 * Runs ONLY when MEMORY_DATABASE_URL is configured (the shared Neon pool AG-004
 * tool_* tables are created on). Exercises genuine durable tool storage: schema
 * migrations, register/persist, version persistence, enable/disable persistence,
 * restart durability, and uniqueness constraints. Skipped without the DB URL.
 */

const DATABASE_URL = process.env.MEMORY_DATABASE_URL;

const suite = DATABASE_URL && DATABASE_URL.trim().length > 0 ? describe : describe.skip;

const ns = `int-tools-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

const mgr: ToolActor = {
  group: ToolActorGroup.ToolManager,
  id: 'mgr-int',
  namespaces: [ns],
  securityClearance: ToolSecurityLevel.Internal,
};

suite(
  'AG-004 - real PostgreSQL tool backend (integration)',
  () => {
    let pool: pg.Pool;
    let repo: PostgresToolRepository;

    const spec = (name: string, version = '1.0.0'): ToolSpecification => ({
      name,
      description: `Int tool ${name}`,
      version,
      category: 'COMPUTATION' as ToolSpecification['category'],
      inputSchema: { safeParse: () => ({ success: true, data: {} }) } as never,
      outputSchema: { safeParse: () => ({ success: true, data: { ok: true } }) } as never,
      handler: { name, invoke: () => ({ ok: true }) },
      securityLevel: 'INTERNAL' as ToolSpecification['securityLevel'],
      executionPolicy: {
        timeoutMs: 1000,
        maxInputBytes: 1024,
        maxOutputBytes: 1024,
        retryPolicy: { maxRetries: 0, backoffBaseMs: 10, backoffMaxMs: 50 },
        securityLevel: 'INTERNAL' as ToolSpecification['securityLevel'],
      },
    });

    beforeAll(async () => {
      pool = createPostgresPool(DATABASE_URL!);
      repo = new PostgresToolRepository({ pool });
      const applied = await repo.migrate();
      expect(applied).toBeGreaterThanOrEqual(0);
    }, 120000);

    afterAll(async () => {
      if (repo) {
        await repo.clear().catch(() => undefined);
      }
      if (pool) {
        await pool.end().catch(() => undefined);
      }
    });

    it('migrates tool schema (200+) without conflicting with other subsystems', async () => {
      const res = await pool.query(
        'SELECT version FROM schema_migrations WHERE version >= 200 AND version <= 299 ORDER BY version',
      );
      expect(res.rows.length).toBeGreaterThanOrEqual(3);
      expect(res.rows.map((r) => Number(r.version))).toEqual([200, 201, 202]);
    });

    it('registers and persists a portable tool definition (calculator)', async () => {
      const service = new ToolManagerService({
        repository: repo,
        config: ToolConfigSchema.parse({ TOOLS_STORAGE_BACKEND: 'durable' }),
        eventLog: new ToolEventLog(),
      });
      const def = await service.register(createCalculatorSpecification(), mgr, ns);
      const record = await repo.getById(def.id);
      expect(record?.name).toBe('calculator');
      expect(record?.version).toBe('1.0.0');
      expect(record?.enabled).toBe(true);
    });

    it('enforces the unique (name, version) constraint - fail closed', async () => {
      const name = `dup-${ns}`;
      await repo.save({
        id: `tool:${name}:v1.0.0`,
        name,
        description: 'd',
        version: '1.0.0',
        category: ToolCategory.Computation,
        securityLevel: ToolSecurityLevel.Internal,
        permissions: [],
        executionPolicy: {
          timeoutMs: 1,
          maxInputBytes: 1,
          maxOutputBytes: 1,
          retryPolicy: { maxRetries: 0, backoffBaseMs: 1, backoffMaxMs: 1 },
          securityLevel: ToolSecurityLevel.Internal,
        },
        enabled: true,
        metadata: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      await expect(
        repo.save({
          id: `tool:${name}:v1.0.0`,
          name,
          description: 'd2',
          version: '1.0.0',
          category: ToolCategory.Computation,
          securityLevel: ToolSecurityLevel.Internal,
          permissions: [],
          executionPolicy: {
            timeoutMs: 1,
            maxInputBytes: 1,
            maxOutputBytes: 1,
            retryPolicy: { maxRetries: 0, backoffBaseMs: 1, backoffMaxMs: 1 },
            securityLevel: ToolSecurityLevel.Internal,
          },
          enabled: true,
          metadata: {},
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      ).rejects.toThrow();
    });

    it('persists enable/disable state and survives a repository re-open', async () => {
      const service = new ToolManagerService({
        repository: repo,
        config: ToolConfigSchema.parse({}),
      });
      const def = await service.register(spec(`sts-${ns}`, '1.0.0'), mgr, ns);
      await service.disable(def.name, mgr, ns);

      // Re-open a fresh repository over the same pool to simulate restart.
      const freshRepo = new PostgresToolRepository({ pool });
      const record = await freshRepo.getById(def.id);
      expect(record?.enabled).toBe(false);
    });

    it('lists with deterministic pagination and filtering', async () => {
      await repo.save({
        id: `tool:aaa-${ns}:v1.0.0`,
        name: `aaa-${ns}`,
        description: 'd',
        version: '1.0.0',
        category: ToolCategory.Computation,
        securityLevel: ToolSecurityLevel.Internal,
        permissions: [],
        enabled: true,
        metadata: {},
        executionPolicy: {
          timeoutMs: 1,
          maxInputBytes: 1,
          maxOutputBytes: 1,
          retryPolicy: { maxRetries: 0, backoffBaseMs: 1, backoffMaxMs: 1 },
          securityLevel: ToolSecurityLevel.Internal,
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      const res = await repo.list(
        {},
        { offset: 0, limit: 5, sortBy: 'name', sortDirection: 'asc' },
      );
      expect(res.total).toBeGreaterThanOrEqual(1);
      expect(res.items.length).toBeGreaterThanOrEqual(1);
      expect(res.hasMore).toBe(false);
    });

    it('removes a persisted tool', async () => {
      const def = await repo.save({
        id: `tool:rm-${ns}:v1.0.0`,
        name: `rm-${ns}`,
        description: 'd',
        version: '1.0.0',
        category: ToolCategory.Computation,
        securityLevel: ToolSecurityLevel.Internal,
        permissions: [],
        enabled: true,
        metadata: {},
        executionPolicy: {
          timeoutMs: 1,
          maxInputBytes: 1,
          maxOutputBytes: 1,
          retryPolicy: { maxRetries: 0, backoffBaseMs: 1, backoffMaxMs: 1 },
          securityLevel: ToolSecurityLevel.Internal,
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      expect(await repo.remove(def.id)).toBe(true);
      expect(await repo.remove(def.id)).toBe(false);
    });

    it('is healthy over a live connection', async () => {
      const health = await repo.healthAsync();
      expect(health.healthy).toBe(true);
    });
  },
  180000,
);
