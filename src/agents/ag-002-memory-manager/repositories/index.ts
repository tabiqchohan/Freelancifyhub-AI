import type {
  MemoryKey,
  MemoryNamespace,
  MemoryRecord,
  MemoryRecordFilter,
} from '../types/index.js';

/**
 * Repository abstraction (spec §15, prompt §11). Abstracts persistence with
 * plain CRUD semantics and version-guarded updates. No business logic lives
 * here — validation, authorization and lifecycle decisions belong to the
 * service layer. The concrete in-memory implementation is test infrastructure.
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
  count(filter?: MemoryRecordFilter): Promise<number>;
  exists(namespace: MemoryNamespace, key: MemoryKey): Promise<boolean>;
}
