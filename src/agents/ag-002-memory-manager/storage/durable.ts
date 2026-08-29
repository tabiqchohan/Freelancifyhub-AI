import { MemoryConfigurationError } from '../errors/index.js';
import type { MemoryRecord } from '../types/index.js';
import type {
  MemoryStorageCapabilities,
  MemoryStorageMetrics,
  StorageHealth,
} from './capabilities.js';
import { createDurableCapabilities } from './capabilities.js';
import type { MemoryStorageAdapter } from './index.js';

/**
 * Sprint 10 — provider-neutral durable persistence contract.
 *
 * The AG-002 project has NO production database dependency. This module defines
 * the durable persistence CONTRACT and the clearly identified IMPLEMENTATION
 * BOUNDARY where a real database backend (Postgres, DynamoDB, Redis, ...) would
 * plug in. It deliberately does NOT invent a fake disk/database backend merely
 * to make a test pass — the in-memory adapter remains the only concrete
 * implementation and is explicitly non-durable.
 *
 * A backend that implements {@link DurableStorageAdapter} genuinely survives
 * process restarts and MUST use {@link createDurableCapabilities} so the
 * capability model distinguishes durable from non-durable storage.
 */

/**
 * Explicit durability guarantee surfaced by a durable adapter (Sprint 10).
 * Consumed by the event/retry layers so a durable write is only reported
 * successful after the backend confirms it persisted.
 */
export interface DurableWriteResult {
  readonly durablyPersisted: boolean;
  readonly acknowledgedAt: string;
}

/** Options a concrete durable backend is constructed with. */
export interface DurableStorageOptions {
  readonly connection?: string;
  readonly region?: string;
  readonly table?: string;
  readonly [key: string]: unknown;
}

/**
 * The durable persistence contract a real backend must satisfy. Extends the
 * storage surface with explicit durability primitives in addition to the
 * standard {@link MemoryStorageAdapter} contract.
 */
export interface DurableStorageAdapter extends MemoryStorageAdapter {
  readonly durable: true;
  /**
   * Writes the record and confirms durability (fsync/commit/ack). Throws a
   * {@link MemoryStorageError} when the backend could not confirm persistence —
   * callers MUST NOT report success for an unpersisted write.
   */
  durableWrite(record: Parameters<MemoryStorageAdapter['write']>[0]): Promise<DurableWriteResult>;
  /**
   * Re-reads a record from the durable source, bypassing any process-local
   * cache, to verify what has actually been persisted.
   */
  reload(namespace: string, key: string): Promise<MemoryRecord | undefined>;
  /** Flushes/durably-commits all pending writes if the backend buffers them. */
  flush?(): Promise<void>;
  /** Backend capabilities — MUST advertise `durable` (via createDurableCapabilities). */
  capabilities(): MemoryStorageCapabilities;
  health(): StorageHealth;
  metrics(): MemoryStorageMetrics;
}

/**
 * Registry of concrete durable backends. Real providers register themselves
 * here (e.g. `registerDurableBackend('postgres', buildPostgresBackend)`). An
 * empty registry means no durable backend is wired yet — the boundary is
 * identified and documented rather than silently faked.
 */
const durableBackends = new Map<string, () => DurableStorageAdapter>();

/** Registers a concrete durable backend factory (returns the previous, if any). */
export function registerDurableBackend(
  name: string,
  factory: () => DurableStorageAdapter,
): (() => DurableStorageAdapter) | undefined {
  const previous = durableBackends.get(name);
  durableBackends.set(name, factory);
  return previous;
}

/** Lists the names of registered durable backends. */
export function listDurableBackends(): readonly string[] {
  return Array.from(durableBackends.keys());
}

/**
 * Resolves a registered durable backend. Fail-closed: an unknown or
 * unregistered backend raises a typed {@link MemoryConfigurationError} instead
 * of falling back to non-durable (or fake-durable) storage.
 */
export function createDurableStorageAdapter(backend: string): DurableStorageAdapter {
  const factory = durableBackends.get(backend);
  if (factory === undefined) {
    throw new MemoryConfigurationError(
      `No durable storage backend registered for "${backend}". ` +
        'Durable persistence is an identified implementation boundary; no production ' +
        'database backend is wired yet. Register one via registerDurableBackend().',
      { details: { backend, registered: listDurableBackends() } },
    );
  }
  return factory();
}

/**
 * Returns a durable capability set for a named backend, OR null when the
 * backend is unknown. Never fabricates durability for the in-memory backend.
 */
export function durableCapabilitiesFor(backend: string): MemoryStorageCapabilities | null {
  const factory = durableBackends.get(backend);
  if (factory === undefined) {
    return null;
  }
  return createDurableCapabilities(backend);
}
