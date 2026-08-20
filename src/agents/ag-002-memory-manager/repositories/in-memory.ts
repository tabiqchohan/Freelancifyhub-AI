import { MemoryLifecycleState } from '../enums/index.js';
import { MemoryConflictError, MemoryNotFoundError } from '../errors/index.js';
import type { MemoryRepository } from './index.js';
import { InMemoryStorageAdapter } from '../storage/in-memory.js';
import type { MemoryStorageAdapter } from '../storage/index.js';
import type {
  MemoryKey,
  MemoryNamespace,
  MemoryRecord,
  MemoryRecordFilter,
} from '../types/index.js';

/**
 * Deterministic in-memory repository.
 *
 * TEST / IN-MEMORY INFRASTRUCTURE ONLY. Wraps an in-memory storage adapter and
 * enforces record/id uniqueness plus version-guarded updates. It is not
 * production persistence and is fully replaceable via the {@link MemoryRepository}
 * contract.
 */
export class InMemoryMemoryRepository implements MemoryRepository {
  readonly name = 'in-memory-memory-repository';

  private readonly storage: MemoryStorageAdapter;
  private readonly ids = new Map<string, string>();

  constructor(storage: MemoryStorageAdapter = new InMemoryStorageAdapter()) {
    this.storage = storage;
  }

  private addressOf(namespace: MemoryNamespace, key: MemoryKey): string {
    return `${namespace}\u0000${key}`;
  }

  async create(record: MemoryRecord): Promise<MemoryRecord> {
    const existing = await this.storage.read(record.namespace, record.key);
    if (existing !== undefined && existing.lifecycle !== MemoryLifecycleState.Deleted) {
      throw new MemoryConflictError(
        `Memory already exists at namespace ${record.namespace} key ${record.key}`,
        { details: { namespace: record.namespace, key: record.key } },
      );
    }

    const taken = this.ids.get(record.id);
    if (taken !== undefined) {
      throw new MemoryConflictError(`Memory id ${record.id} is already in use`, {
        details: { id: record.id },
      });
    }

    await this.storage.write(record);
    this.ids.set(record.id, this.addressOf(record.namespace, record.key));
    return record;
  }

  async get(namespace: MemoryNamespace, key: MemoryKey): Promise<MemoryRecord | undefined> {
    return this.storage.read(namespace, key);
  }

  async save(record: MemoryRecord): Promise<MemoryRecord> {
    await this.storage.write(record);
    this.ids.set(record.id, this.addressOf(record.namespace, record.key));
    return record;
  }

  async update(
    namespace: MemoryNamespace,
    key: MemoryKey,
    expectedVersion: number,
    record: MemoryRecord,
  ): Promise<MemoryRecord> {
    const existing = await this.storage.read(namespace, key);
    if (existing === undefined) {
      throw new MemoryNotFoundError(`Memory not found at namespace ${namespace} key ${key}`, {
        details: { namespace, key },
      });
    }
    if (existing.version !== expectedVersion) {
      throw new MemoryConflictError(
        `Memory version conflict at namespace ${namespace} key ${key}: expected ${expectedVersion}, found ${existing.version}`,
        { details: { namespace, key, expectedVersion, foundVersion: existing.version } },
      );
    }

    await this.storage.write(record);
    return record;
  }

  async delete(namespace: MemoryNamespace, key: MemoryKey): Promise<boolean> {
    const removed = await this.storage.remove(namespace, key);
    if (removed) {
      const address = this.addressOf(namespace, key);
      for (const [id, storedAddress] of this.ids) {
        if (storedAddress === address) {
          this.ids.delete(id);
        }
      }
    }
    return removed;
  }

  async list(filter?: MemoryRecordFilter): Promise<readonly MemoryRecord[]> {
    return this.storage.list(undefined, filter);
  }

  async count(filter?: MemoryRecordFilter): Promise<number> {
    return (await this.storage.list(undefined, filter)).length;
  }

  async exists(namespace: MemoryNamespace, key: MemoryKey): Promise<boolean> {
    return (await this.storage.read(namespace, key)) !== undefined;
  }
}
