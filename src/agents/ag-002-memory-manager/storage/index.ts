import { MemoryLifecycleState, StorageTier } from '../enums/index.js';
import type {
  MemoryId,
  MemoryKey,
  MemoryNamespace,
  MemoryRecord,
  MemoryRecordFilter,
} from '../types/index.js';
import type {
  MemoryStorageCapabilities,
  MemoryStorageMetrics,
  MemoryStorageTransaction,
  StorageHealth,
} from './capabilities.js';

/**
 * Storage abstraction (spec §18, prompt §12). Defines the hot/warm/cold tier
 * contract without coupling AG-002 to any provider. The concrete in-memory
 * implementation is test infrastructure only — real persistence (Postgres,
 * Redis, Qdrant, ...) is out of scope for Sprint 1.
 *
 * Sprint 6 strengthens the durable-storage boundary: typed paginated queries,
 * by-id reads, declared capabilities, runtime health, safe metrics, and a
 * transaction abstraction. Authorization is NOT part of this layer (see
 * security/index.ts).
 */
export interface MemoryStorageAdapter {
  readonly name: string;
  read(namespace: MemoryNamespace, key: MemoryKey): Promise<MemoryRecord | undefined>;
  getById(id: MemoryId): Promise<MemoryRecord | undefined>;
  write(record: MemoryRecord, tier?: StorageTier): Promise<void>;
  remove(namespace: MemoryNamespace, key: MemoryKey): Promise<boolean>;
  /** Sprint 9 — physically removes every record in a namespace (DSR erasure). */
  removeByNamespace(namespace: MemoryNamespace): Promise<number>;
  list(tier?: StorageTier, filter?: MemoryRecordFilter): Promise<readonly MemoryRecord[]>;
  /** Declares the capabilities this adapter actually supports (prompt §11). */
  capabilities(): MemoryStorageCapabilities;
  /** Runtime health snapshot (prompt §11). */
  health(): StorageHealth;
  /** Safe aggregate metrics — never record content (prompt §15). */
  metrics(): MemoryStorageMetrics;
  /**
   * Transaction boundary (prompt §7). In-memory adapter provides a best-effort
   * snapshot with rollback; it does not claim ACID durability.
   */
  transaction(): MemoryStorageTransaction;
  /** Test/observability helper: clears all records. */
  clear(): void;
  /** Test/observability helper: number of stored records. */
  size(): number;
}

/**
 * Tier mapping derived from the storage strategy (spec §18): archived records
 * live in the cold tier; everything else is hot. Warm is reserved for future
 * embeddings/metadata.
 */
export function tierForRecord(record: MemoryRecord): StorageTier {
  return record.lifecycle === MemoryLifecycleState.Archived ? StorageTier.Cold : StorageTier.Hot;
}

export * from './capabilities.js';
export * from './factory.js';
export * from './durable.js';
