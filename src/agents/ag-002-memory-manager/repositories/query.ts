import { MemoryValidationError } from '../errors/index.js';
import type { MemoryRecord, MemoryRecordFilter } from '../types/index.js';

/**
 * Sprint 6 — Deterministic repository query / pagination contract (prompt §3,
 * §4). Provides a typed, deterministic paginated read over the repository.
 * Pagination is keyset/cursor-based so ordering stays stable regardless of
 * concurrent writes between pages. This is NOT a database implementation and
 * carries no authorization responsibility (see security/index.ts).
 */

/** Sortable record attributes for deterministic ordering (prompt §4). */
export type RepositorySortField = 'createdAt' | 'updatedAt' | 'priority' | 'key' | 'version';

/** Sort direction. */
export type RepositorySortDirection = 'asc' | 'desc';

/** A single primary sort key. */
export interface RepositorySort {
  readonly field: RepositorySortField;
  readonly direction: RepositorySortDirection;
}

/** Deterministic repository query (filter + sort + pagination). */
export interface RepositoryQuery {
  /** Attribute filter (shared with repository listing). */
  readonly filter?: MemoryRecordFilter;
  /** Deterministic sort; defaults to `{ field: 'createdAt', direction: 'asc' }`. */
  readonly sort?: RepositorySort;
  /** Maximum items on this page (validated against config maximum). */
  readonly limit?: number;
  /** Opaque continuation token from a previous page. */
  readonly cursor?: string;
  readonly maxPageSize: number;
}

/**
 * A {@link RepositoryQuery} with defaults applied — `sort` and `limit` are
 * guaranteed present. Produced by {@link validateRepositoryQuery}.
 */
export type ResolvedRepositoryQuery = RepositoryQuery & {
  readonly sort: RepositorySort;
  readonly limit: number;
};

/** A single page of results with deterministic continuation. */
export interface RepositoryPage {
  readonly items: readonly MemoryRecord[];
  /** Opaque cursor for the next page, when more records remain. */
  readonly nextCursor?: string;
  readonly hasMore: boolean;
  readonly total: number;
  readonly pageSize: number;
}

const PRIORITY_RANK: Readonly<Record<MemoryRecord['priority'], number>> = {
  CRITICAL: 4,
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
};

/** Deterministic record sort key used both for ordering and cursor resume. */
export interface RepositorySortKey {
  readonly value: string | number;
  readonly namespace: string;
  readonly key: string;
}

/** Computes the primary sort value for a record. */
export function sortValueOf(record: MemoryRecord, field: RepositorySortField): string | number {
  switch (field) {
    case 'createdAt':
    case 'updatedAt':
      return record[field];
    case 'priority':
      return PRIORITY_RANK[record.priority] ?? 0;
    case 'key':
      return record.key;
    case 'version':
      return record.version;
  }
}

/** Compares two records deterministically under a sort specification. */
export function compareRecordsSorted(
  a: MemoryRecord,
  b: MemoryRecord,
  sort: RepositorySort,
): number {
  const av = sortValueOf(a, sort.field);
  const bv = sortValueOf(b, sort.field);
  let cmp =
    typeof av === 'number' && typeof bv === 'number'
      ? av - bv
      : String(av).localeCompare(String(bv));
  if (sort.direction === 'desc') {
    cmp = -cmp;
  }
  if (cmp !== 0) return cmp;
  // Stable, globally-unique tiebreak: namespace then key.
  const ns = a.namespace.localeCompare(b.namespace);
  if (ns !== 0) return ns;
  return a.key.localeCompare(b.key);
}

/**
 * Returns true when the record sorts strictly AFTER the given cursor tuple
 * under the sort specification (used to resume pagination deterministically).
 */
export function recordAfterCursor(
  record: MemoryRecord,
  sort: RepositorySort,
  last: RepositorySortKey,
): boolean {
  const value = sortValueOf(record, sort.field);
  const primary =
    typeof value === 'number' && typeof last.value === 'number'
      ? value - last.value
      : String(value).localeCompare(String(last.value));
  let cmp = primary;
  if (sort.direction === 'desc') {
    cmp = -cmp;
  }
  if (cmp !== 0) return cmp > 0;
  const ns = record.namespace.localeCompare(last.namespace);
  if (ns !== 0) return ns > 0;
  return record.key.localeCompare(last.key) > 0;
}

interface CursorPayload {
  readonly f: RepositorySortField;
  readonly o: RepositorySortDirection;
  readonly /** last sort value */ v: string | number;
  readonly /** last namespace */ n: string;
  readonly /** last key */ k: string;
}

const CURSOR_SHAPE: (keyof CursorPayload)[] = ['f', 'o', 'v', 'n', 'k'];

/**
 * Encodes a repository sort key as an opaque, base64url JSON cursor. The data
 * is not secret — it is a deterministic continuation token.
 */
export function encodeRepositoryCursor(sort: RepositorySort, last: RepositorySortKey): string {
  const payload: CursorPayload = {
    f: sort.field,
    o: sort.direction,
    v: last.value,
    n: last.namespace,
    k: last.key,
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * Decodes and validates an opaque cursor. Invalid or malformed cursors throw a
 * {@link MemoryValidationError} — never silently ignored.
 */
export function decodeRepositoryCursor(cursor: string): {
  readonly sort: RepositorySort;
  readonly last: RepositorySortKey;
} {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch (cause) {
    throw new MemoryValidationError('Malformed repository cursor', {
      code: 'INVALID_CURSOR',
      cause,
    });
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new MemoryValidationError('Malformed repository cursor', {
      code: 'INVALID_CURSOR',
    });
  }
  const payload = raw as Record<string, unknown>;
  for (const field of CURSOR_SHAPE) {
    if (!(field in payload)) {
      throw new MemoryValidationError('Malformed repository cursor', {
        code: 'INVALID_CURSOR',
      });
    }
  }
  const f = payload.f as string;
  const o = payload.o as string;
  const v = payload.v;
  const n = payload.n as string;
  const k = payload.k as string;
  const validFields: RepositorySortField[] = [
    'createdAt',
    'updatedAt',
    'priority',
    'key',
    'version',
  ];
  const validDirs: RepositorySortDirection[] = ['asc', 'desc'];
  if (!validFields.includes(f as RepositorySortField)) {
    throw new MemoryValidationError('Malformed repository cursor', {
      code: 'INVALID_CURSOR',
    });
  }
  if (!validDirs.includes(o as RepositorySortDirection)) {
    throw new MemoryValidationError('Malformed repository cursor', {
      code: 'INVALID_CURSOR',
    });
  }
  if (
    typeof v !== 'string' &&
    typeof v !== 'number' &&
    typeof n !== 'string' &&
    typeof k !== 'string'
  ) {
    throw new MemoryValidationError('Malformed repository cursor', {
      code: 'INVALID_CURSOR',
    });
  }
  return {
    sort: { field: f as RepositorySortField, direction: o as RepositorySortDirection },
    last: { value: v as string | number, namespace: n, key: k },
  };
}

/** Validates a repository query: positive limit, sane page size, safe cursor. */
export function validateRepositoryQuery(query: RepositoryQuery): ResolvedRepositoryQuery {
  if (query.maxPageSize < 1) {
    throw new MemoryValidationError('Repository max page size must be positive', {
      code: 'INVALID_PAGINATION',
    });
  }
  const limit = query.limit ?? query.maxPageSize;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new MemoryValidationError('Repository page limit must be a positive integer', {
      code: 'INVALID_PAGINATION',
    });
  }
  if (limit > query.maxPageSize) {
    throw new MemoryValidationError('Repository page limit exceeds the configured maximum', {
      code: 'INVALID_PAGINATION',
      details: { limit, maxPageSize: query.maxPageSize },
    });
  }
  const sort = query.sort ?? { field: 'createdAt', direction: 'asc' as const };
  if (query.cursor !== undefined) {
    decodeRepositoryCursor(query.cursor);
  }
  return { ...query, sort, limit };
}
