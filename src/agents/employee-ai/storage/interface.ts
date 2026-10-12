import type { EmployeeArtifactBytes, EmployeeTaskRecord } from './types.js';

/**
 * Prompts19 Phase 2 — durable storage contract for AI Employee tasks.
 *
 * The current implementation persists task + result metadata and the reviewed
 * ZIP bytes. The in-memory working set in the service is a bounded cache of
 * these durable records, so a restart can rebuild state and serve artifacts.
 */
export interface EmployeeTaskRepository {
  /** True when records outlive the process (PostgreSQL), false for in-memory. */
  readonly durable: boolean;
  /** Apply schema migrations (no-op for the in-memory backend). */
  migrate(): Promise<void>;
  /** Insert or update the full task record. */
  saveTask(record: EmployeeTaskRecord): Promise<void>;
  /** Fetch one task record. */
  getTask(taskId: string): Promise<EmployeeTaskRecord | undefined>;
  /** Most-recent records (newest first), bounded by `limit`. */
  listTasks(limit?: number): Promise<EmployeeTaskRecord[]>;
  /** Records whose phase is not terminal (interrupted by a restart). */
  listNonTerminal(): Promise<EmployeeTaskRecord[]>;
  /** Delete a task record. */
  deleteTask(taskId: string): Promise<void>;
  /** Persist the reviewed ZIP bytes for a task. */
  saveArtifact(taskId: string, artifact: EmployeeArtifactBytes, expiresAt: number): Promise<void>;
  /** Fetch the reviewed ZIP bytes for a task. */
  getArtifact(taskId: string): Promise<EmployeeArtifactBytes | undefined>;
  /** Delete the persisted ZIP bytes for a task. */
  deleteArtifact(taskId: string): Promise<void>;
  /**
   * Evict artifacts whose TTL has passed and any task record past its
   * `expiresAt`. Returns the evicted records so the caller can remove the
   * on-disk workspaces they referenced.
   */
  reap(now: number): Promise<EmployeeTaskRecord[]>;
  /** Liveness probe used by readiness reporting. */
  health(): Promise<{ healthy: boolean; message: string }>;
  /** Release storage handles. */
  close(): Promise<void>;
}
