import { describe, expect, it } from 'vitest';

import {
  InMemoryToolRepository,
  ToolCategory,
  ToolSecurityLevel,
} from '../../../../src/agents/ag-004-tool-manager/index.js';
import {
  ToolConflictError,
  ToolNotFoundError,
} from '../../../../src/agents/ag-004-tool-manager/errors/index.js';
import type { ToolRecord } from '../../../../src/agents/ag-004-tool-manager/repositories/types.js';

function record(name: string, version = '1.0.0', overrides: Partial<ToolRecord> = {}): ToolRecord {
  const at = new Date().toISOString();
  return {
    id: `tool:${name}:v${version}`,
    name,
    description: `${name} desc`,
    version,
    category: ToolCategory.Computation,
    securityLevel: ToolSecurityLevel.Internal,
    permissions: [],
    executionPolicy: {
      timeoutMs: 1000,
      maxInputBytes: 1024,
      maxOutputBytes: 1024,
      retryPolicy: { maxRetries: 0, backoffBaseMs: 10, backoffMaxMs: 50 },
      securityLevel: ToolSecurityLevel.Internal,
    },
    enabled: true,
    metadata: {},
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

describe('AG-004 InMemoryToolRepository', () => {
  it('saves and retrieves a record by id', async () => {
    const repo = new InMemoryToolRepository();
    await repo.save(record('alpha'));
    const got = await repo.getById('tool:alpha:v1.0.0');
    expect(got?.name).toBe('alpha');
  });

  it('rejects duplicate save (fail closed)', async () => {
    const repo = new InMemoryToolRepository();
    await repo.save(record('alpha'));
    await expect(repo.save(record('alpha'))).rejects.toBeInstanceOf(ToolConflictError);
  });

  it('requires an existing record for update', async () => {
    const repo = new InMemoryToolRepository();
    await expect(repo.update(record('ghost'))).rejects.toBeInstanceOf(ToolNotFoundError);
  });

  it('updates an existing record', async () => {
    const repo = new InMemoryToolRepository();
    await repo.save(record('alpha'));
    const updated = record('alpha', '1.0.0', { description: 'new' });
    await expect(repo.update(updated)).resolves.toMatchObject({ description: 'new' });
  });

  it('lists with deterministic pagination and filtering', async () => {
    const repo = new InMemoryToolRepository();
    await repo.save(record('alpha', '1.0.0'));
    await repo.save(record('bravo', '1.0.0', { enabled: false }));
    await repo.save(record('charlie', '1.0.0'));

    const allFiltered = await repo.list({}, { offset: 0, limit: 10 });
    expect(allFiltered.total).toBe(3);

    const enabled = await repo.list({ enabled: true }, { offset: 0, limit: 10 });
    expect(enabled.total).toBe(2);

    const byName = await repo.list({ name: 'alpha' }, { offset: 0, limit: 10 });
    expect(byName.total).toBe(1);
    expect(byName.items[0]?.id).toBe('tool:alpha:v1.0.0');

    const page = await repo.list({}, { offset: 1, limit: 1 });
    expect(page.items.length).toBe(1);
    expect(page.hasMore).toBe(true);
  });

  it('returns deterministic ordering by name ascending', async () => {
    const repo = new InMemoryToolRepository();
    await repo.save(record('bravo'));
    await repo.save(record('alpha'));
    const res = await repo.list({}, { offset: 0, limit: 10, sortBy: 'name', sortDirection: 'asc' });
    expect(res.items.map((r) => r.id)).toEqual(['tool:alpha:v1.0.0', 'tool:bravo:v1.0.0']);
  });

  it('removes a record and reports existence', async () => {
    const repo = new InMemoryToolRepository();
    await repo.save(record('alpha'));
    expect(await repo.remove('tool:alpha:v1.0.0')).toBe(true);
    expect(await repo.remove('tool:alpha:v1.0.0')).toBe(false);
  });

  it('reports healthy and supports clear', async () => {
    const repo = new InMemoryToolRepository();
    expect((await repo.healthAsync()).healthy).toBe(true);
    await repo.save(record('alpha'));
    await repo.clear();
    expect((await repo.list({}, { offset: 0, limit: 10 })).total).toBe(0);
  });
});
