import type {
  MemoryId,
  MemoryKey,
  MemoryNamespace,
  MemoryRecord,
  MemoryRecordFilter,
} from '../types/index.js';
import type { RepositoryPage, RepositoryQuery } from './query.js';
import type {
  MemoryStorageCapabilities,
  MemoryStorageMetrics,
  StorageHealth,
} from '../storage/capabilities.js';

/**
 * Repository abstraction (spec §15, prompt §11). Abstracts persistence with
 * plain CRUD semantics and version-guarded updates. No business logic lives
 * here — validation, authorization and lifecycle decisions belong to the
 * service layer. The concrete in-memory implementation is test infrastructure.
 *
 * Sprint 6 strengthens the durable-storage boundary: deterministic paginated
 * queries, by-id reads, declared capabilities, runtime health and safe metrics.
 * Authorization is NOT performed here (see security/index.ts).
 */
export interface MemoryRepository {
  readonly name: string;
  /**
   * Creates a record. Throws a conflict when the namespace/key is already
   * occupied by a live (non-deleted) record or the id is already in use
   * (idempotency, AC-MEM-7). A deleted tombstone may be recreated.
   */
  create(record: MemoryRecord): Promise<MemoryRecord>;
  get(namespace: MemoryNamespace, key: MemoryKey): Promise<MemoryRecord | undefined>;
  /** Reads a record by its globally-unique id (Sprint 6). */
  getById(id: MemoryId): Promise<MemoryRecord | undefined>;
  /**
   * Upsert: stores the record at its namespace/key, replacing any existing
   * record (used for lifecycle writes such as soft-delete and archive).
   */
  save(record: MemoryRecord): Promise<MemoryRecord>;
  /**
   * Optimistic-concurrency update (spec §15: `409` on version mismatch).
   * Throws a conflict when the stored version differs from `expectedVersion`.
   */
  update(
    namespace: MemoryNamespace,
    key: MemoryKey,
    expectedVersion: number,
    record: MemoryRecord,
  ): Promise<MemoryRecord>;
  /** Physically removes a record; returns whether it existed. */
  delete(namespace: MemoryNamespace, key: MemoryKey): Promise<boolean>;
  list(filter?: MemoryRecordFilter): Promise<readonly MemoryRecord[]>;
  /**
   * Deterministic paginated query over the repository (Sprint 6, prompt §3-§4).
   * Enforces filter, sort and page-size limits; returns a typed page with a
   * continuation cursor.
   */
  query(query: RepositoryQuery): Promise<RepositoryPage>;
  count(filter?: MemoryRecordFilter): Promise<number>;
  exists(namespace: MemoryNamespace, key: MemoryKey): Promise<boolean>;
  /** Declares the capabilities this repository actually supports (Sprint 6). */
  capabilities(): MemoryStorageCapabilities;
  /** Runtime health snapshot (Sprint 6). */
  health(): StorageHealth;
  /** Safe aggregate metrics — never record content (Sprint 6, prompt §15). */
  metrics(): MemoryStorageMetrics;
}

export * from './query.js';
