import type { ToolRecord, ToolRecordFilter, ToolRecordPage, ToolPagination } from './types.js';

/**
 * Tool repository abstraction. The service depends on this interface — never
 * directly on PostgreSQL. Concrete implementations: InMemoryToolRepository
 * (tests/local) and PostgresToolRepository (durable production).
 */
export interface ToolRepository {
  readonly name: string;
  /** Registers a tool record (fails on duplicate id). */
  save(record: ToolRecord): Promise<ToolRecord>;
  /** Updates an existing record (fails when missing). */
  update(record: ToolRecord): Promise<ToolRecord>;
  /** Gets a record by id; undefined when missing. */
  getById(id: string): Promise<ToolRecord | undefined>;
  /** Lists records with filtering + deterministic pagination. */
  list(filter: ToolRecordFilter, pagination: ToolPagination): Promise<ToolRecordPage>;
  /** Removes a record; true when it existed. */
  remove(id: string): Promise<boolean>;
  /** Health check. */
  healthAsync(): Promise<{ healthy: boolean; message: string }>;
  /** Clears all records. Test helper. */
  clear(): Promise<void>;
}
