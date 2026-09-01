# AG-002 Memory Manager — Sprint 13 (Real Durable PostgreSQL Persistence v1)

## 1. Objective

Deliver **real, durable persistence** for AG-002's memory system by wiring the
existing `durable` storage backend to a genuine **PostgreSQL database** (hosted
on Neon) — not a file-backed proxy, not an in-memory fallback, not a stubbed
adapter. `MEMORY_STORAGE_BACKEND=durable` now actually persists memory records
and lifecycle events to PostgreSQL across process restarts.

Sprint 13 addresses the audit's **CRIT-2 ("No real durable backend")**. It stays
strictly in scope: it reuses the existing AG-002 abstractions (repository,
storage-adapter contract, event-log contract) and does **not** redesign them,
and does **not** implement any deferred items (composition root, real
AgentExecutor, AG-003, AG-004, LLM, vector search).

## 2. Existing storage architecture

AG-002 exposes two synchronous storage backends behind
`MemoryStorageAdapter` / `DurableStorageAdapter` and `MemoryRepository`:

- `in-memory` — process-local maps via `InMemoryStorageAdapter`.
- `durable` — previously a process-local adapter registered for the durable
  contract; it had **no durable sink**, which was the CRIT-2 gap.

The durable backend is selected through `MEMORY_STORAGE_BACKEND` in `src/config`
(`MemoryStorageConfig`), resolved by the storage factory in
`src/agents/ag-002-memory-manager/storage/factory.ts`.

## 3. PostgreSQL architecture

A single real backend, `postgres`, is registered at module load:

- `postgres-backend.ts` — connection-string resolution (fail-closed), adapter
  construction (runs migrations), and registration with the storage factory.
- `postgres.ts` — `PostgresStorageAdapter` (real pool, parameterized queries,
  `durableWrite`, `reload`, transactions, synchronous views + async
  `sizeAsync`/`clearAsync`/`healthAsync`).
- `repositories/postgres.ts` — `PostgresMemoryRepository` implementing the full
  `MemoryRepository` contract against the adapter pool.
- `events/postgres.ts` — `PostgresEventSink`, the smallest durable integration
  for the synchronous event-log contract (canonical hosting + PG write-through).
- `schema.ts` — versioned DDL and `migrateSchema`/`acquireClient`/
  `pendingMigrations`.

Default wiring: `durable` → `postgres` (`DEFAULT_DURABLE_BACKEND = 'postgres'`).
The backend is **lazily registered** — no connection is opened at import time;
a connection is established only when the factory actually constructs the
adapter.

## 4. Database schema

`schema_migrations` records applied migration versions. Two migrations exist
(`SCHEMA_VERSION = 2`):

- **v1** — tables `memory_records` and `memory_events`, plus `schema_migrations`,
  with a namespaced uniqueness constraint on `(namespace, key)` and a global
  unique constraint on `id`.
- **v2** (`event-correlation-columns`) — adds `correlation_id`, `request_id`,
  `service`, `severity`, `category`, `source`, `event_type` to `memory_events`
  so replay/audit can carry tenant-level diagnostics. Idempotent (`IF NOT
EXISTS`).

All writes use parameterized statements; identifiers are from a fixed column
list (`storage/row-mapping.ts`), never user input.

## 5. Configuration

- `MEMORY_STORAGE_BACKEND` — `durable` (production default for this repo's
  `.env`) or `in-memory` (local tests/dev).
- `MEMORY_DATABASE_URL` — the PostgreSQL connection string. For `durable`
  without `MEMORY_STORAGE_DURABLE_BACKEND`, the factory defaults `durable` →
  `postgres` and requires `MEMORY_DATABASE_URL`.

Fail-closed: if `durable` is requested and the connection string is missing,
empty, or `postgres:`-prefixed without a usable URL, construction throws
`MemoryConfigurationError`. There is **no silent in-memory fallback**.

The URL/credentials are read only inside the agent-002 storage layer and are
**never logged, echoed, or exported**. The integration test suite refuses to run
when the URL is absent (`describe.skip`).

## 6. Migration mechanism

`migrateSchema(pool)` applies only pending migrations, in version order, each in
its own transaction and recorded in `schema_migrations` (unique migration-name
guard → idempotent). `pendingMigrations(pool)` reports what remains. Both
migrations re-run cleanly (0 pending) against the live Neon database.

## 7. Storage adapter

`PostgresStorageAdapter` implements `DurableStorageAdapter`:

- CRUD (`get`/`getById`/`put`/`delete`/`list`), `durableWrite` (durable insert/
  update with conflict handling), and `reload` (hydrate process stats from PG).
- The synchronous contract members (`size`, `clear`, `health`) are served by
  **process-local observability views**; real durability probes are exposed via
  `sizeAsync`, `clearAsync`, and `healthAsync` (a genuine `SELECT count(*)`
  against the pool).
- Pool lifecycle via `createPostgresPool` (`max` 10, `connectionTimeoutMillis`
  10s, `query_timeout` 15s, `idleTimeoutMillis` 30s, TLS override for Neon).

## 8. Repository integration

`PostgresMemoryRepository` binds the `MemoryRepository` contract to the pool:

- `create` enforces live uniqueness and the global `id` uniqueness, with
  `Deleted` tombstones recreatable (explicit unique ids).
- `save` upserts; `update` is version-guarded (matching version only, else 409)
  using contiguous parameterized placeholders.
- `delete`, `eraseById`, `eraseByNamespace`; `list` via adapter SQL; `query`
  revalidates the repository query and applies JS-side ordering + stable cursor
  pagination (`recordAfterCursor` / encoded cursor).

## 9. Transactions

Real ACID transactions via a dedicated client: `adapter.transaction(fn)` begins,
runs `fn(client)`, and commits on success / rolls back on any thrown error. The
adapter routes reads/writes to the active transaction client while one is open.
Integration tests prove commit persists and rollback discards.

## 10. Concurrency

- Version-guarded optimistic updates (conflict → 409) prevent lost updates.
- Global `id` uniqueness and `(namespace, key)` uniqueness are enforced by
  PostgreSQL constraints as defense-in-depth alongside the repository checks.
- Pool sizing (max 10) with connection/query timeouts prevents hung-DB
  scenarios from blocking callers indefinitely.

## 11. Idempotency

- Migrations: re-running `migrateSchema` applies nothing new (0 pending).
- `memory_events` inserts use `ON CONFLICT (event_id) DO NOTHING`, so replaying
  a persisted event is a no-op.
- Repository `save`/upsert semantics are repeatable; `eraseByNamespace` +
  recreate works across connections.

## 12. Pagination

`query` sorting and cursor pagination are deterministic (stable sort by
namespace/key with a returned cursor encoding the last record's position).
`list` respects the adapter limit contract. Event read-back pagination bounds
limits to a safe range (1–1000).

## 13. Lifecycle persistence

Lifecycle state lives on the record row (`lifecycle`, `archived_at` etc.) via
the fixed 19-column mapping in `row-mapping.ts`. A record created, updated, and
read back on a **fresh connection** (new pool + adapter + repository) retains
its lifecycle. A `Deleted` tombstone is durable and blocks live recreation until
it is erased.

## 14. Event persistence

`PostgresEventSink` is the smallest durable integration for the fully
synchronous `EventLogContract`:

- Canonical hosting (validation, sanitization, local sequence, dedup) stays in
  the existing `InMemoryEventLog`; the event system was **not** redesigned.
- Each canonical event is written through to `memory_events` with a
  database-derived monotonic sequence (survives restarts and is unique).
- Async read-back for audit/replay/restart: `readBackStart`, `readByNamespace`,
  `getById`, `count`, `healthAsync`.
- Secrets in metadata pass through the canonical `sanitizeEventMetadata` path,
  so only the redacted form (`[REDACTED]`) is ever persisted.

## 15. Cache interaction

No new cache layer was introduced (cache design remains deferred). The event
sink's in-memory log is the live read path for the running process; the durable
copy in PostgreSQL is the source of truth across restarts.

## 16. DSR behavior

Data-Subject-Request operations (`eraseById`, `eraseByNamespace`) execute real
`DELETE` statements against PostgreSQL, so erasure is durable and not limited to
process lifetime. Namespaced erasure is used by integration-test cleanup.

## 17. Security

- Parameterized queries everywhere; no string-concatenated SQL from user input.
- Fixed column-name allowlist in `row-mapping.ts`.
- Fail-closed connection resolution; `MemoryConfigurationError` on missing URL.
- Credentials never logged or surfaced; pool TLS required for Neon
  (`sslmode=require` in the URL + explicit `ssl` override).
- Event metadata redacted before persistence (no plaintext secrets on disk/DB).
- `query_timeout`/`connectionTimeoutMillis` fail fast rather than hanging.

## 18. Health/capabilities

- Capabilities (durable, sizes, transactions, health, etc.) reported by
  `PostgresStorageAdapter.metadata` and the postgres backend descriptor.
- `healthAsync()` performs a real `SELECT count(*)` probe
  (`healthy`, `checkedAt`, `stored`, `message`); the synchronous `health()`
  reflects the process-local view.

## 19. Failure/recovery

- Transient Neon slowness manifests as a connection timeout → fail-closed
  `MemoryStorageError` ("Unable to acquire a PostgreSQL connection"); callers
  can retry.
- A partially applied migration cannot re-apply (recorded in
  `schema_migrations`); a failed migration rolls back its own transaction.
- `close()` releases pool resources; restart durability is handled by reading
  everything back from PG.

## 20. Restart durability

Proven in integration tests by simulating a brand-new process:

1. A record written via one pool/adapter/repository is read back on an entirely
   fresh pool + adapter + repository (`get` returns the same content/version).
2. Events persisted through one sink are read back through a newly constructed
   sink (`readByNamespace` / `count`).

## 21. Integration tests

`tests/integration/agents/ag-002-memory-manager/postgres.integration.test.ts`
(15 tests) runs **only when `MEMORY_DATABASE_URL` is present** (otherwise the
suite is `describe.skip`). Coverage: migration idempotency, adapter CRUD +
durable write + reload + health probe, repository create/get/create-conflict/
version-guarded update/save-upsert/delete, query pagination with cursor, real
transaction commit and rollback, record restart durability, and (Phase 13)
canonical event persistence + redaction + event restart durability.

## 22. Test results

| Gate                           | Result                                                         |
| ------------------------------ | -------------------------------------------------------------- |
| Neon integration suite         | 15/15 passed (43s)                                             |
| AG-002 unit suite              | 625 passed (1 pre-existing flaky timing test, passes on rerun) |
| Scoped `src` typecheck (`tsc`) | Clean (exit 0)                                                 |

## 23. Known limitations

- The synchronous `MemoryStorageAdapter`/`DurableStorageAdapter`/event-log
  contracts require synchronous `size`/`clear`/`health`; those are satisfied by
  process-local observability views while real probes are exposed as
  `…Async` variants.
- The live read path within a running process is the event sink's in-memory
  canonical log; PostgreSQL is the durable copy, not the live query engine (the
  repository, by contrast, is fully PG-backed).
- Neon SSL `sslmode=require` currently triggers a pg v9 deprecation warning
  (treated as `verify-full`); the explicit `ssl` override is correct for today.
- No connection-pool metrics/observability wiring into the runtime yet (deferred).

## 24. Deferred work

Composition root wiring for production (constructing the durable backend from
env in the app bootstrap), connection-pool telemetry/retries, background
consolidation over the durable store, vector search, and the runtime cache
performance layer all remain explicitly deferred (as the Sprint scoped them).

## 25. Scope compliance

Reused the existing abstractions and model; added a real PostgreSQL backend and
a smallest-durable event sink. **Not** implemented (as prohibited): AG-003,
AG-004, LLM integration, real AgentExecutor changes, vector search, external
integrations, redesign of AG-002's event/repository contracts.

Changes are **uncommitted** by design (Sprint 13 spec: do not commit/push).
