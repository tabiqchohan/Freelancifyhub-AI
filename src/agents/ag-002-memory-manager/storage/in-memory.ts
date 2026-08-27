import { StorageTier } from '../enums/index.js';
import type {
  MemoryId,
  MemoryKey,
  MemoryNamespace,
  MemoryRecord,
  MemoryRecordFilter,
} from '../types/index.js';
import { tierForRecord, type MemoryStorageAdapter } from './index.js';
import type {
  MemoryStorageCapabilities,
  MemoryStorageMetrics,
  MemoryStorageTransaction,
  StorageHealth,
} from './capabilities.js';
import { createInMemoryCapabilities } from './capabilities.js';

/**
 * Deterministic in-memory storage adapter.
 *
 * TEST / IN-MEMORY INFRASTRUCTURE ONLY. This is not production persistence.
 * It exists so the repository/service contracts can be exercised deterministically
 * and is deliberately replaceable by real storage adapters in later sprints.
 *
 * Sprint 6: implements the strengthened storage contract — by-id reads, a
 * transaction boundary with snapshot rollback, declared capabilities, runtime
 * health and safe metrics. Authorization is never performed here.
 */
export class InMemoryStorageAdapter implements MemoryStorageAdapter {
  readonly name = 'in-memory-memory-storage';

  private readonly records = new Map<string, MemoryRecord>();
  private readonly tiers = new Map<string, StorageTier>();
  private readonly idAddress = new Map<MemoryId, string>();

  private metricsState = {
    reads: 0,
    writes: 0,
    queries: 0,
    conflicts: 0,
  };

  private keyOf(namespace: MemoryNamespace, key: MemoryKey): string {
    return `${namespace}\u0000${key}`;
  }

  private addressOfId(id: MemoryId): string | undefined {
    return this.idAddress.get(id);
  }

  async read(namespace: MemoryNamespace, key: MemoryKey): Promise<MemoryRecord | undefined> {
    this.metricsState.reads += 1;
    const stored = this.records.get(this.keyOf(namespace, key));
    return stored === undefined ? undefined : structuredClone(stored);
  }

  async getById(id: MemoryId): Promise<MemoryRecord | undefined> {
    this.metricsState.reads += 1;
    const address = this.addressOfId(id);
    if (address === undefined) {
      return undefined;
    }
    const stored = this.records.get(address);
    return stored === undefined ? undefined : structuredClone(stored);
  }

  async write(record: MemoryRecord, tier: StorageTier = tierForRecord(record)): Promise<void> {
    const address = this.keyOf(record.namespace, record.key);
    if (this.records.has(address)) {
      this.metricsState.conflicts += 1;
    }
    this.metricsState.writes += 1;
    this.records.set(address, structuredClone(record));
    this.tiers.set(address, tier);
    this.idAddress.set(record.id, address);
  }

  async remove(namespace: MemoryNamespace, key: MemoryKey): Promise<boolean> {
    const address = this.keyOf(namespace, key);
    const removed = this.records.delete(address);
    this.tiers.delete(address);
    if (removed) {
      for (const [id, storedAddress] of this.idAddress) {
        if (storedAddress === address) {
          this.idAddress.delete(id);
        }
      }
    }
    return removed;
  }

  async list(tier?: StorageTier, filter?: MemoryRecordFilter): Promise<readonly MemoryRecord[]> {
    this.metricsState.queries += 1;
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

  capabilities(): MemoryStorageCapabilities {
    return createInMemoryCapabilities();
  }

  health(): StorageHealth {
    const tiers = {
      [StorageTier.Hot]: 0,
      [StorageTier.Warm]: 0,
      [StorageTier.Cold]: 0,
    };
    for (const tier of this.tiers.values()) {
      tiers[tier] += 1;
    }
    return {
      healthy: true,
      checkedAt: new Date().toISOString(),
      stored: this.records.size,
      tiers,
      message: 'in-memory storage operational',
    };
  }

  metrics(): MemoryStorageMetrics {
    return { ...this.metricsState };
  }

  transaction(): MemoryStorageTransaction {
    return {
      name: 'in-memory-transaction',
      run: async <T>(work: () => Promise<T>): Promise<T> => {
        const snapshot = new Map(
          Array.from(this.records.entries(), ([k, v]) => [k, structuredClone(v)]),
        );
        const tiersSnapshot = new Map(this.tiers);
        const idSnapshot = new Map(this.idAddress);
        try {
          return await work();
        } catch (error) {
          this.records.clear();
          for (const [k, v] of snapshot) {
            this.records.set(k, structuredClone(v));
          }
          this.tiers.clear();
          for (const [k, v] of tiersSnapshot) {
            this.tiers.set(k, v);
          }
          this.idAddress.clear();
          for (const [k, v] of idSnapshot) {
            this.idAddress.set(k, v);
          }
          throw error;
        }
      },
    };
  }

  clear(): void {
    this.records.clear();
    this.tiers.clear();
    this.idAddress.clear();
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
