import { MemoryValidationError } from '../errors/index.js';
import type { MemoryContent, MemoryKey, MemoryNamespace, MemoryMetadata } from '../types/index.js';
import { validateMemoryIdempotencyKey } from '../validators/index.js';

export type { MemoryKey, MemoryNamespace };

/** A create-request fingerprint captured for idempotency comparisons (Sprint 10). */
export interface MemoryIdempotencyEntry {
  readonly namespace: MemoryNamespace;
  readonly key: MemoryKey;
  readonly fingerprint: string;
}

/**
 * Sprint 10 — process-local idempotency registry for memory creation.
 *
 * Records the logical request (namespace, key and a content fingerprint)
 * associated with a caller-provided idempotency key. Namespace-scoped: an
 * idempotency key in one namespace never affects another. This registry is
 * intentionally in-memory — a durable idempotency registry across restarts is
 * part of the durable-storage boundary (see storage/durable.ts) and is not
 * fabricated here.
 */
export class MemoryIdempotencyRegistry {
  private readonly entries = new Map<string, MemoryIdempotencyEntry>();

  private static totalKey(namespace: MemoryNamespace, idempotencyKey: string): string {
    return `${namespace}\u0000${idempotencyKey}`;
  }

  /** Returns the stored entry for the key in this namespace, if any. */
  get(namespace: MemoryNamespace, idempotencyKey: string): MemoryIdempotencyEntry | undefined {
    return this.entries.get(MemoryIdempotencyRegistry.totalKey(namespace, idempotencyKey));
  }

  /**
   * Records (or overwrites) the logical create for a key within a namespace.
   * Returns the previous binding, if any.
   */
  set(
    namespace: MemoryNamespace,
    idempotencyKey: string,
    entry: MemoryIdempotencyEntry,
  ): MemoryIdempotencyEntry | undefined {
    const previous = this.entries.get(
      MemoryIdempotencyRegistry.totalKey(namespace, idempotencyKey),
    );
    this.entries.set(MemoryIdempotencyRegistry.totalKey(namespace, idempotencyKey), entry);
    return previous;
  }

  /** Count of tracked idempotency bindings (observability, no content). */
  size(): number {
    return this.entries.size;
  }
}

/**
 * Computes a stable fingerprint of the logical CREATE request, excluding
 * per-attempt generated fields (id, createdAt). Two calls that would produce an
 * equivalent record yield the same fingerprint; any meaningful difference in
 * the logical target or content yields a different fingerprint.
 */
export function memoryCreateFingerprint(fields: {
  readonly namespace: MemoryNamespace;
  readonly key: MemoryKey;
  readonly content: MemoryContent;
  readonly metadata?: MemoryMetadata;
}): string {
  const payload = {
    namespace: fields.namespace,
    key: fields.key,
    content: fields.content,
    metadata: fields.metadata ?? {},
  };
  return stableStringDigest(JSON.stringify(payload));
}

/** FNV-1a 32-bit hex digest — deterministic, dependency-free, stable across runs. */
export function stableStringDigest(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Validates an optional idempotency key. Empty-only is rejected; a malformed
 * value (non-string or whitespace-only) is rejected with a validation error.
 * Returns undefined when the key is absent (create is then non-idempotent).
 */
export function optionalIdempotencyKey(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return validateMemoryIdempotencyKey(value);
}

export class MemoryIdempotencyValidationError extends MemoryValidationError {
  constructor(message: string) {
    super(message, { code: 'MEMORY_IDEMPOTENCY_VALIDATION_ERROR' });
  }
}
