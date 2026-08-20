import type { StorageTier } from '../enums/index.js';
import type {
  MemoryKey,
  MemoryNamespace,
  MemoryRecord,
  MemoryRecordFilter,
} from '../types/index.js';
import { tierForRecord } from './index.js';
import type { MemoryStorageAdapter } from './index.js';

/**
 * Deterministic in-memory storage adapter.
 *
 * TEST / IN-MEMORY INFRASTRUCTURE ONLY. This is not production persistence.
 * It exists so the repository/service contracts can be exercised deterministically
 * and is deliberately replaceable by real storage adapters in later sprints.
 */
export class InMemoryStorageAdapter implements MemoryStorageAdapter {
  readonly name = 'in-memory-memory-storage';

  private readonly records = new Map<string, MemoryRecord>();
  private readonly tiers = new Map<string, StorageTier>();

  private keyOf(namespace: MemoryNamespace, key: MemoryKey): string {
    return `${namespace}\u0000${key}`;
  }

  async read(namespace: MemoryNamespace, key: MemoryKey): Promise<MemoryRecord | undefined> {
    const stored = this.records.get(this.keyOf(namespace, key));
    return stored === undefined ? undefined : structuredClone(stored);
  }

  async write(record: MemoryRecord, tier: StorageTier = tierForRecord(record)): Promise<void> {
    const address = this.keyOf(record.namespace, record.key);
    this.records.set(address, structuredClone(record));
    this.tiers.set(address, tier);
  }

  async remove(namespace: MemoryNamespace, key: MemoryKey): Promise<boolean> {
    const address = this.keyOf(namespace, key);
    const removed = this.records.delete(address);
    this.tiers.delete(address);
    return removed;
  }

  async list(tier?: StorageTier, filter?: MemoryRecordFilter): Promise<readonly MemoryRecord[]> {
    const results: MemoryRecord[] = [];

    for (const [address, stored] of this.records) {
      if (tier !== undefined && this.tiers.get(address) !== tier) {
        continue;
      }
      if (filter !== undefined && !this.matches(stored, filter)) {
        continue;
      }
      results.push(structuredClone(stored));
    }

    return results;
  }

  clear(): void {
    this.records.clear();
    this.tiers.clear();
  }

  size(): number {
    return this.records.size;
  }

  private matches(record: MemoryRecord, filter: MemoryRecordFilter): boolean {
    if (filter.namespace !== undefined && record.namespace !== filter.namespace) {
      return false;
    }
    if (filter.key !== undefined && record.key !== filter.key) {
      return false;
    }
    if (filter.type !== undefined && record.type !== filter.type) {
      return false;
    }
    if (filter.priority !== undefined && record.priority !== filter.priority) {
      return false;
    }
    if (filter.securityLevel !== undefined && record.securityLevel !== filter.securityLevel) {
      return false;
    }
    if (filter.lifecycle !== undefined && record.lifecycle !== filter.lifecycle) {
      return false;
    }
    if (filter.owner !== undefined) {
      if (record.owner.kind !== filter.owner.kind || record.owner.id !== filter.owner.id) {
        return false;
      }
    }
    return true;
  }
}
