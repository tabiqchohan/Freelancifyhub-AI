import type { ToolRecord, ToolRecordFilter, ToolRecordPage, ToolPagination } from './types.js';
import type { ToolRepository } from './interface.js';
import { ToolConflictError, ToolNotFoundError } from '../errors/index.js';

/**
 * In-memory tool repository. Non-durable — used for tests and the default
 * in-memory backend. Mirrors AG-003's InMemoryKnowledgeRepository.
 */
export class InMemoryToolRepository implements ToolRepository {
  readonly name = 'in-memory-tool-repository';

  private readonly records = new Map<string, ToolRecord>();

  async save(record: ToolRecord): Promise<ToolRecord> {
    if (this.records.has(record.id)) {
      throw new ToolConflictError(`Tool ${record.id} already exists`, {
        details: { id: record.id },
      });
    }
    this.records.set(record.id, record);
    return record;
  }

  async update(record: ToolRecord): Promise<ToolRecord> {
    if (!this.records.has(record.id)) {
      throw new ToolNotFoundError(`Tool ${record.id} not found`, { details: { id: record.id } });
    }
    this.records.set(record.id, record);
    return record;
  }

  async getById(id: string): Promise<ToolRecord | undefined> {
    return this.records.get(id);
  }

  async list(
    filter: ToolRecordFilter = {},
    pagination: ToolPagination = { offset: 0, limit: 50 },
  ): Promise<ToolRecordPage> {
    let items = Array.from(this.records.values());

    if (filter.name !== undefined) {
      items = items.filter((r) => r.name === filter.name);
    }
    if (filter.category !== undefined) {
      items = items.filter((r) => r.category === filter.category);
    }
    if (filter.enabled !== undefined) {
      items = items.filter((r) => r.enabled === filter.enabled);
    }

    const sortBy = pagination.sortBy ?? 'created_at';
    const dir = pagination.sortDirection === 'desc' ? -1 : 1;
    items.sort((a, b) => {
      const key = sortBy === 'name' ? 'name' : sortBy === 'updated_at' ? 'updatedAt' : 'createdAt';
      const aVal = a[key];
      const bVal = b[key];
      if (aVal === bVal) return 0;
      return aVal < bVal ? -dir : dir;
    });

    const total = items.length;
    const offset = Math.max(0, pagination.offset);
    const limit = Math.max(1, pagination.limit);
    const paged = items.slice(offset, offset + limit);

    return {
      items: paged,
      total,
      offset,
      limit,
      hasMore: offset + limit < total,
    };
  }

  async remove(id: string): Promise<boolean> {
    return this.records.delete(id);
  }

  async healthAsync(): Promise<{ healthy: boolean; message: string }> {
    return { healthy: true, message: 'in-memory tool repository healthy' };
  }

  async clear(): Promise<void> {
    this.records.clear();
  }
}
