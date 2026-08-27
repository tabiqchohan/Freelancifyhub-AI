# AG-002 Shared Memory Manager — Sprint 6 Persistence & Durable Repository Readiness

**Agent:** AG-002 · **Scope:** Sprint 6 — Persistence, Storage Abstraction & Durable Repository Readiness · **Status:** Implemented
**Source of truth:** `docs/shared-memory-architecture-v1.md` · **Task:** `prompts/prompts27`

## Summary

Sprint 6 strengthens the durable-storage boundary of AG-002 without introducing any real database integration. It adds deterministic, cursor-based paginated queries; by-id reads; typed storage/repository contracts for declared capabilities, runtime health and safe metrics; and a transaction boundary that treats the in-memory adapter as a replaceable stand-in for a future durable backend. Access control and lifecycle/consolidation behavior are unchanged — this sprint is read-side and boundary hardening only.

Per prompt §14, **this sprint was deliberately NOT committed or pushed.** All AG-001 + AG-002 Sprint 1–5B baseline tests continue passing. 27 new Sprint 6 tests are green. Full gates: `npm test` (**973 passing** = 946 baseline + 27 new), `npm run typecheck` (18 pre-existing errors only), `npm run lint` (27 pre-existing errors only), `npm run build` (2 pre-existing errors only) — no new errors introduced.

## Deliverables

| Area          | Files                                                                                                                                                                                                                                                                |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Config        | `config/schema.ts` — added `MEMORY_STORAGE_BACKEND` (default `in-memory`) and `MEMORY_STORAGE_MAX_PAGE_SIZE` (default `50`) + constants                                                                                                                              |
| Query         | `repositories/query.ts` — `RepositorySortField/Direction/Sort`, `RepositoryQuery`, `RepositoryPage`, `RepositorySortKey`, `sortValueOf`, `compareRecordsSorted`, `recordAfterCursor`, `encodeRepositoryCursor` / `decodeRepositoryCursor`, `validateRepositoryQuery` |
| Repository    | `repositories/index.ts` + `repositories/in-memory.ts` — added `getById`, `query`, `capabilities`, `health`, `metrics` to `MemoryRepository` and `InMemoryMemoryRepository`                                                                                           |
| Storage       | `storage/index.ts` + `storage/in-memory.ts` — added `getById`, `capabilities`, `health`, `metrics`, `transaction` to `MemoryStorageAdapter` and `InMemoryStorageAdapter`                                                                                             |
| Capabilities  | `storage/capabilities.ts` — `StorageCapability`, `MemoryStorageCapabilities`, `StorageHealth`, `MemoryStorageMetrics`, `MemoryStorageTransaction`, `AtomicWork`, `createInMemoryCapabilities`                                                                        |
| Factory       | `storage/factory.ts` — `createStorageAdapter` (config-driven, fail-closed on unknown backend)                                                                                                                                                                        |
| Serialization | `utils/serialization.ts` — prototype-pollution guard (`__proto__` / `constructor` / `prototype` rejected with `PROTOTYPE_POLLUTION_GUARD`)                                                                                                                           |
| Tests         | `tests/unit/agents/ag-002-memory-manager/storage-query.test.ts` — 27 tests (Sprint 6) plus extended `config.test.ts` coverage                                                                                                                                        |
| Docs          | `docs/ag-002-memory-manager-sprint6-v1.md` — this document                                                                                                                                                                                                           |

## Sprint 6 Contracts

- `RepositoryQuery` — deterministic filter + sort + pagination; `sort` defaults to `{ field: 'createdAt', direction: 'asc' }`; `maxPageSize` (config-driven) caps every page.
- `RepositoryPage` — `items`, `nextCursor` (opaque continuation), `hasMore`, `total`, `pageSize`.
- `RepositorySort` field set — `createdAt`, `updatedAt`, `priority`, `key`, `version`, each `asc`/`desc`. Ordering is deterministic with a stable, globally-unique tiebreak (namespace then key).
- Keyset/cursor pagination — the cursor encodes the last `{ field, direction, value, namespace, key }` tuple; the next page resumes strictly after it, so ordering stays stable even across concurrent writes. Malformed or foreign cursors fail closed with `INVALID_CURSOR`.
- `MemoryStorageCapabilities` / `StorageHealth` — adapters declare what they genuinely support and expose a runtime health snapshot (healthy flag, checked timestamp, stored count, per-tier counts, message).
- `MemoryStorageMetrics` — safe aggregate counters (`reads`, `writes`, `queries`, `conflicts`) that never contain record content. Repository-level `conflicts` counts version/id conflicts.
- `MemoryStorageTransaction` (`run`) — transaction boundary; the in-memory adapter provides a consistent snapshot with rollback on failure. It explicitly does **not** claim ACID durability.
- `createStorageAdapter(config?)` — returns the in-memory adapter for the configured backend and **fails closed** on any unknown backend rather than silently falling back.
- Prototype-pollution guard — `serializeMemoryRecord` refuses `__proto__`, `constructor`, and `prototype` keys anywhere in `content`/`metadata`.

## Query & Pagination Design

1. `repository.query(input)` validates the query (positive integer limit, limit ≤ `maxPageSize`, safe cursor) via `validateRepositoryQuery`.
2. Matching records are read via the existing `storage.list` filter path and sorted deterministically with `compareRecordsSorted` (numeric-typed fields compare numerically; direction applied; namespace → key tiebreak).
3. If a cursor is supplied, the scan resumes strictly after the cursor tuple with `recordAfterCursor` — guaranteeing no overlap and no skipped rows between pages.
4. `nextCursor` is emitted only when `hasMore`; consuming pages repeatedly walks the whole set exactly once.

## Constants

- `DEFAULT_MEMORY_STORAGE_BACKEND = 'in-memory'`
- `DEFAULT_MEMORY_STORAGE_MAX_PAGE_SIZE = 50`

## Security Verification

- The transaction, capabilities, health and metrics surfaces never expose record content.
- Metrics carry only aggregate counters; `StorageHealth` exposes counts and status, never data.
- Malformed/foreign pagination cursors are rejected with `INVALID_CURSOR` (fail-closed).
- Unknown storage backends fail closed at the factory — no silent fallback that could mask misconfiguration.
- Serialization rejects prototype-pollution keys before any record is emitted or parsed.
- No AG-003/AG-004 behavior, no external DB, no embeddings/vector store, no network I/O was added.

## Backward Compatibility

- Existing AG-001 and AG-002 Sprint 1–5B tests continue to pass (973 total after Sprint 6).
- No tests deleted, skipped, or weakened; baseline gates (18 typecheck / 27 lint / 2 build errors) unchanged.
- No AG-001 files modified; Spring 1–5B files are not rewritten.
- The existing CRUD / version-safe writes / immutability / serialization / filtering contracts were untouched and the stop-condition noted in the prompt (avoid duplicating existing contracts) was honoured — only the genuinely missing pieces were added.
- No commit or push was performed (prompt §14).
