import type { StorageTier } from '../enums/index.js';

/**
 * Sprint 6 — Storage capability, health and observability contracts (prompt
 * §11, §15). These reflect what the current adapter ACTUALLY supports — they
 * never claim capabilities that are not implemented.
 */

/** Capabilities a storage adapter may support (prompt §11). */
export type StorageCapability =
  | 'read'
  | 'write'
  | 'versionedWrite'
  | 'delete'
  | 'archive'
  | 'query'
  | 'pagination'
  | 'transactions';

/** Declared capabilities of a storage adapter. */
export interface MemoryStorageCapabilities {
  readonly name: string;
  readonly backend: string;
  /** The list of capabilities this adapter genuinely supports. */
  readonly capabilities: readonly StorageCapability[];
  /** True when the adapter supports the given capability. */
  supports?(capability: StorageCapability): boolean;
}

/** Runtime health snapshot of a storage adapter (prompt §11). */
export interface StorageHealth {
  readonly healthy: boolean;
  readonly checkedAt: string;
  readonly stored: number;
  readonly tiers: Readonly<Record<StorageTier, number>>;
  readonly message: string;
}

/** Safe, aggregate storage metrics (prompt §15). Never contains record content. */
export interface MemoryStorageMetrics {
  readonly reads: number;
  readonly writes: number;
  readonly conflicts: number;
  readonly queries: number;
}

/** Callable handler around a piece of atomic work (prompt §7). */
export type AtomicWork<T> = () => Promise<T>;

/**
 * Transaction boundary (prompt §7). Defines a clean abstraction that a future
 * durable adapter may implement with real DB transactions. The in-memory
 * adapter provides the strongest practical equivalent: a consistent snapshot
 * with rollback on failure. It does NOT claim ACID durability properties that
 * the in-memory adapter cannot provide.
 */
export interface MemoryStorageTransaction {
  readonly name: string;
  run<T>(work: AtomicWork<T>): Promise<T>;
}

/** Declares full in-memory adapter capabilities. */
export function createInMemoryCapabilities(backend = 'in-memory'): MemoryStorageCapabilities {
  return {
    name: 'in-memory-storage-capabilities',
    backend,
    capabilities: [
      'read',
      'write',
      'versionedWrite',
      'delete',
      'archive',
      'query',
      'pagination',
      'transactions',
    ],
    supports(capability: StorageCapability): boolean {
      return this.capabilities.includes(capability);
    },
  };
}
