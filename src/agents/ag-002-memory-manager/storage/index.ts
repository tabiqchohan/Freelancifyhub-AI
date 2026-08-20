import { MemoryLifecycleState, StorageTier } from '../enums/index.js';
import type {
  MemoryKey,
  MemoryNamespace,
  MemoryRecord,
  MemoryRecordFilter,
} from '../types/index.js';

/**
 * Storage abstraction (spec §18, prompt §12). Defines the hot/warm/cold tier
 * contract without coupling AG-002 to any provider. The concrete in-memory
 * implementation is test infrastructure only — real persistence (Postgres,
 * Redis, Qdrant, ...) is out of scope for Sprint 1.
 */
export interface MemoryStorageAdapter {
  readonly name: string;
  read(namespace: MemoryNamespace, key: MemoryKey): Promise<MemoryRecord | undefined>;
  write(record: MemoryRecord, tier?: StorageTier): Promise<void>;
  remove(namespace: MemoryNamespace, key: MemoryKey): Promise<boolean>;
  list(tier?: StorageTier, filter?: MemoryRecordFilter): Promise<readonly MemoryRecord[]>;
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
