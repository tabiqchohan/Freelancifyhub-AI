import type { MemoryNamespace } from '../types/index.js';

/**
 * Sprint 10 — deterministic, bounded, TTL cache.
 *
 * Used for retrieval acceleration (by-id and by-namespace/key reads). The cache
 * is a pure value cache: it NEVER stores authorization decisions and every key
 * is namespace-scoped by the caller so no cross-tenant leakage is possible.
 * Entries are TTL-bound and evicted LRU once the configured bound is exceeded.
 */

/** Aggregate cache metrics — never exposes keys or cached values. */
export interface MemoryCacheMetrics {
  readonly size: number;
  readonly hits: number;
  readonly misses: number;
  readonly evictions: number;
  readonly expired: number;
}

export interface MemoryCacheOptions {
  /** Whether the cache is active. When false, get/set are no-ops. */
  readonly enabled?: boolean;
  /** Maximum entries before LRU eviction. */
  readonly maxEntries: number;
  /** Default TTL in ms (0 = no expiry). */
  readonly ttlMs?: number;
}

interface CacheSlot<T> {
  readonly value: T;
  readonly insertedAt: number;
  readonly expiresAt: number | undefined;
  /** Monotonic recency counter for LRU ordering. */
  readonly recency: number;
}

/**
 * Bounded, TTL-aware, LRU-evicting cache. Not a global authorization cache —
 * treats values opaquely and never inspects actor/security context.
 */
export class MemoryCache<V> {
  private readonly enabled: boolean;
  private readonly maxEntries: number;
  private readonly defaultTtlMs: number;

  private readonly slots = new Map<string, CacheSlot<V>>();
  private now = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private expired = 0;

  constructor(options: MemoryCacheOptions) {
    this.enabled = options.enabled ?? true;
    this.maxEntries = options.maxEntries;
    this.defaultTtlMs = options.ttlMs ?? 0;
  }

  /** Timestamp hook for deterministic tests (defaults to the real clock). */
  set nowRef(value: number) {
    this.now = value;
  }

  get size(): number {
    return this.slots.size;
  }

  get active(): boolean {
    return this.enabled;
  }

  private currentTime(): number {
    return this.now > 0 ? this.now : Date.now();
  }

  /** Returns a cached value, or undefined on miss, expiry or disabled mode. */
  get(key: string): V | undefined {
    if (!this.enabled) {
      this.misses += 1;
      return undefined;
    }
    const slot = this.slots.get(key);
    if (slot === undefined) {
      this.misses += 1;
      return undefined;
    }
    const now = this.currentTime();
    if (slot.expiresAt !== undefined && now >= slot.expiresAt) {
      this.slots.delete(key);
      this.expired += 1;
      this.misses += 1;
      return undefined;
    }
    this.hits += 1;
    // Refresh recency so a recently-accessed entry is not the LRU victim.
    this.slots.set(key, { ...slot, recency: this.nextRecency() });
    return slot.value;
  }

  /** Stores a value under a key, evicting LRU entries when over the bound. */
  set(key: string, value: V, ttlMs: number = this.defaultTtlMs): void {
    if (!this.enabled) {
      return;
    }
    const currentTime = this.currentTime();
    this.slots.set(key, {
      value,
      insertedAt: currentTime,
      expiresAt: ttlMs > 0 ? currentTime + ttlMs : undefined,
      recency: this.nextRecency(),
    });
    if (this.slots.size > this.maxEntries) {
      this.evictLru();
    }
  }

  /** Removes a single key. */
  invalidate(key: string): void {
    this.slots.delete(key);
  }

  /** Removes every key whose string starts with the given prefix. */
  invalidateByPrefix(prefix: string): void {
    for (const key of Array.from(this.slots.keys())) {
      if (key.startsWith(prefix)) {
        this.slots.delete(key);
      }
    }
  }

  /** Projection helper: invalidate all keys within a namespace. */
  invalidateNamespace(namespace: MemoryNamespace): void {
    this.invalidateByPrefix(`${namespace}\u0000`);
  }

  /** Clears the cache entirely. */
  clear(): void {
    this.slots.clear();
  }

  /** Safe aggregate metrics. */
  metrics(): MemoryCacheMetrics {
    return {
      size: this.slots.size,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      expired: this.expired,
    };
  }

  private recencyCounter = 0;

  private nextRecency(): number {
    this.recencyCounter += 1;
    return this.recencyCounter;
  }

  private evictLru(): void {
    let oldestKey: string | undefined;
    let oldestRecency = Infinity;
    for (const [key, slot] of this.slots) {
      if (slot.recency < oldestRecency) {
        oldestRecency = slot.recency;
        oldestKey = key;
      }
    }
    if (oldestKey !== undefined) {
      this.slots.delete(oldestKey);
      this.evictions += 1;
    }
  }
}

/** Cache key for a namespace/key address (namespace-safe composite). */
export function namespaceAddressKey(namespace: MemoryNamespace, key: string): string {
  return `${namespace}\u0000${key}`;
}

/** Cache key for a by-id lookup (id is globally unique across namespaces). */
export function byIdCacheKey(id: string): string {
  return `id\u0000${id}`;
}

export { CachedMemoryRepository, cacheRepository } from './repository.js';
