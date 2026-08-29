# AG-002 Shared Memory Manager — Sprint 10 DURABLE PERSISTENCE, IDEMPOTENT CREATE & CACHING

**Sprint:** 10
**Status:** IMPLEMENTED
**Based on:** `docs/ag-002-final-gap-audit-v1.md` + `docs/ag-002-memory-manager-sprint9-v1.md`
(Sprint 10 work packages: durable persistence contract, idempotent create, cache/retrieval
acceleration, canonical consolidation).

---

## 1. Executive Summary

Sprint 10 closes the four gaps the Final Gap Audit assigned to Sprint 10 scope:

1. **Durable persistence contract** — a provider-neutral durable storage abstraction that
   _distinguishes_ durable from the existing in-memory implementation and provides an explicit,
   fail-closed implementation boundary. It does **not** fake production durability.
2. **Idempotent memory creation** — caller-supplied idempotency keys that prevent unintended
   duplicate creation, return existing results on identical retries, fail with a typed conflict
   on conflicting retries, are isolated by namespace, and do not duplicate events.
3. **Cache / retrieval acceleration** — a bounded, TTL-based, namespace-safe `MemoryCache` and a
   `CachedMemoryRepository` read-through wrapper with deterministic invalidation on every
   mutating operation.
4. **Canonical consolidation** — only the actual gap (stale-source detection) was fixed; the
   existing canonical path was otherwise preserved, keeping repeated consolidation a no-op.

A configurable, documented, and tested set of persistence/cache settings was added. Quality gates
are preserved: the full suite (1156 tests, +48 new) passes, and the typecheck/lint/build baselines
contain only pre-existing errors.

---

## 2. Scope

**In scope (Sprint 10 only):**

- `StorageCapability` extended with `durable` / `idempotent` / `transactional`.
- Provider-neutral durable boundary: `DurableStorageAdapter`, backend registry, fail-closed
  factory routing, and capability derivation. **Reference/contract only — no fake disk/database.**
- Idempotent create (`idempotencyKey` on `CreateMemoryInput`), key validation, registry,
  fingerprinting, in-flight concurrency guard.
- `MemoryCache` + `CachedMemoryRepository` with TTL, LRU bound, namespace-safe keys, metrics,
  disabled mode, and invalidation on update/restore/archive/expire/erase.
- Consolidation stale-source detection (`sourcesMatch`).
- 48 new tests (Sprint 10 target ≥ 40).

**Out of scope (explicitly NOT implemented in Sprint 10):**

- Any real durable backend integration (none exists in the project architecture).
- AG-001 runtime wiring, dead-flag cleanup, public-barrel/test-double hygiene (Sprint 11).
- AG-003, AG-004, LLM/vector/social-media integration, payments, Stripe.
- Any change to `retrieval/*` or other pre-existing baseline files carrying known typecheck/lint
  errors.

---

## 3. Existing Storage Architecture

Before Sprint 10 the memory manager used a single in-memory implementation:

- `MemoryStorageAdapter` (in `storage/`) — process-local map-backed adapter.
- `MemoryRepository` (in `repositories/`) — wraps the adapter with `create`, `update`, `read`
  (`get`/`getById`), `delete`/`erase`, `query`, and `transaction()`.
- `StorageCapability` + `createInMemoryCapabilities` — described what a backend supports.
- `health()` / `metrics()` on adapters.

**Important truth:** the existing in-memory adapter is process-local and non-durable. It does not
survive restart and makes no persistence guarantee. Sprint 10 keeps that classification explicit
and does **not** relabel it as durable.

---

## 4. Durable Persistence Contract

`storage/durable.ts` introduces a provider-neutral durable abstraction:

- **`DurableStorageAdapter`** — extends `MemoryStorageAdapter` and adds `durable: true`,
  `durableWrite(record)`, optional `reload()`, and optional `flush()`. A provider signals its
  capabilities via `durableCapabilitiesFor(backend)`.
- **`DurableWriteResult`** — the return shape of a durable write (indicates acknowledged
  persistence vs. deferred/queued), so a caller can distinguish "really persisted" from
  "accepted for later".
- **`DurableStorageOptions`** — provider-specific options (timeouts, retries) passed through the
  boundary.
- **Registry** — `registerDurableBackend(name, factory)` / `listDurableBackends()`. No backend is
  registered by default, which is the honest state: AG-002 has no real durable database yet.
- **`createDurableStorageAdapter(backend)`** — **fail-closed**: an unregistered backend throws a
  `MemoryConfigurationError` rather than silently downgrading to non-durable storage.

`storage/factory.ts` routes `MEMORY_STORAGE_BACKEND=durable` through this boundary. Because no
registered backend exists, that configuration **fails closed** with a clear message — it never
silently claims durability it cannot deliver.

---

## 5. Backend Capability Model

`storage/capabilities.ts` extends `StorageCapability` with:

- `'durable'` — survives process restart in a real provider.
- `'idempotent'` — the backend guarantees idempotent writes.
- `'transactional'` — the backend provides real transactions.

Added helpers:

- `DURABLE_STORAGE_CAPABILITIES`, `isDurableCapability()`, `createDurableCapabilities(backend)`.
- `createInMemoryCapabilities` stays **non-durable** — the in-memory backend is explicitly
  `durable: false`.

The capability model makes the durable/non-durable distinction first-class and machine-readable
instead of implied by documentation.

---

## 6. Persistence Configuration

`config/schema.ts` and its consumption added only the settings Sprint 10 actually uses (no dead
flags):

| Key                              | Default    | Meaning                                                  |
| -------------------------------- | ---------- | -------------------------------------------------------- |
| `MEMORY_STORAGE_BACKEND`         | (existing) | selects `in-memory` (default) or `durable`               |
| `MEMORY_STORAGE_DURABLE_BACKEND` | `''`       | name of a registered durable backend; empty = none wired |
| `MEMORY_CACHE_ENABLED`           | `true`     | whether the service wraps its repository in the cache    |
| `MEMORY_CACHE_MAX_ENTRIES`       | `512`      | bound on cache size                                      |
| `MEMORY_CACHE_TTL_MS`            | `60000`    | per-entry time-to-live                                   |

Every value is schema-validated, defaulted, actually consumed (factory routing, cache wiring), and
tested. There are no dead feature flags added by this sprint.

---

## 7. Idempotent Create

`createMemory` accepts an optional `idempotencyKey` (1–128 non-whitespace chars, validated by
`validateMemoryIdempotencyKey`). Semantics:

1. A content-neutral **logical fingerprint** is computed over `(namespace, key, content,
metadata)` via `memoryCreateFingerprint` (FNV-1a digest).
2. **Identical retry** (same key + same fingerprint + existing record) returns the existing record
   and emits a `Retrieved` event — **no new `Created` event, no duplicate record**.
3. **Conflicting retry** (same key, different logical request) throws a typed
   `MemoryConflictError` (`MEMORY_IDEMPOTENCY_CONFLICT_ERROR`).
4. **Namespace isolation** — the registry is scoped by namespace, and the in-flight guard key is
   `namespace \u0000 idempotencyKey`, so one namespace can never collide with another.
5. **Missing key** — requests without a key are **not** treated as idempotent (never silently
   replayed).
6. **Malformed key** — rejected at validation with a `MemoryValidationError`.

The process-local `MemoryIdempotencyRegistry` records satisfied requests. A deterministic
in-flight guard (`idempotencyInFlight`) serializes concurrent identical creates so the second
caller awaits the first and replays its result instead of racing the non-atomic in-memory create.

---

## 8. Idempotency Key Semantics

- Keys are **caller-chosen** identifiers for a logical create request (e.g. a client-generated
  UUID), not derived from content.
- Same key + same logical request ⇒ **safe replay** (returns existing, no side effects).
- Same key + different logical request ⇒ **typed conflict**.
- Keys are **namespace-scoped** — the same key string in two namespaces is independent.
- Replays preserve **versioning** (the existing record, not a new v1) and **lifecycle** (the
  current, authoritative state is returned).
- Registry entries persist for the process lifetime; a genuinely durable idempotency store is part
  of the durable backend boundary (not faked here).

---

## 9. Conflict Handling

Conflicts surface as typed errors, never as silent overwrites or silent drops:

- `MemoryConflictError` with code `MEMORY_IDEMPOTENCY_CONFLICT_ERROR` for conflicting idempotency
  keys.
- Fail-closed `MemoryConfigurationError` for an unregistered durable backend.
- A catch-fallback inside `performCreate` tolerates the case where a _concurrent_ identical create
  won the namespace/key race: if the idempotency key is present and the existing record still
  matches the fingerprint, it returns the existing record instead of a spurious conflict.

Determinism is preserved: identical replay and conflicting retry are order-independent at the
logical level.

---

## 10. Cache Architecture

`cache/index.ts` provides a small, deterministic, dependency-free `MemoryCache<V>`:

- **Bounded** — LRU eviction at `maxEntries` (recency refreshed on access).
- **TTL** — entries expire at `ttlMs`; expired entries are dropped on access.
- **Injectable clock** (`nowRef`) for deterministic tests.
- **Metrics** — `hits`, `misses`, `evictions`, `expired` via `metrics()`.
- **Disabled mode** — `enabled: false` short-circuits get/set.

`cache/repository.ts` provides `CachedMemoryRepository`, a read-through wrapper:

- `get`/`getById` consult the cache on miss and populate it.
- **Namespace-safe keys** — `namespaceAddressKey(ns, key)` and `byIdCacheKey(id)` keep tenants
  distinct and unguessable addresses separate.
- **Clone on write and read** — `structuredClone` both directions preserves the repository's
  immutability contract (callers cannot mutate cached state and poison other readers).
- **Invalidation on every mutation** — `create`, `update`, `save`, `eraseById`, `eraseByNamespace`,
  `delete`, `restore`, `archive`, and `expire` invalidate the relevant entries/namespaces.

The service wraps its repository via `maybeCacheRepository(repository)` when
`MEMORY_CACHE_ENABLED` is true.

---

## 11. Cache Security

- **No global authorization caching** — the cache stores _records_, never authorization
  decisions. Every read still goes through the service's authorization path.
- **Namespace-scoped keys** — includes the namespace context, preventing cross-tenant leakage.
- **Clone in/out** — cached values are deep-cloned, so `getById` callers cannot mutate shared cache
  state or leak references between actors.
- **Metrics are content-free** — no sensitive values in `metrics()`.
- **Erasure safety** — `eraseById`/`eraseByNamespace` invalidate cache entries, so erased records
  cannot return through the cache.

---

## 12. Cache Invalidation

Invalidation is deterministic and tied to the mutation site:

- `update` / `save` → invalidates the by-address and by-id entries for the affected record.
- `restore` → invalidates stale archived state (current lifecycle is re-read from the repository).
- `archive` / `expire` → invalidates the affected entries.
- `eraseById` → invalidates by-id + by-address.
- `eraseByNamespace` → invalidates the entire namespace prefix.

Because invalidation happens inside the wrapper and always precedes a read, no stale version or
stale lifecycle state can be served after a mutation.

---

## 13. Consolidation Review

The existing Sprint 5B consolidation implementation already satisfied: deterministic grouping,
deterministic source ordering, deterministic output key, provenance, namespace isolation,
authorization, no duplicate records, idempotent repeated consolidation, no duplicate events, no
secret leakage, lifecycle handling, and cache invalidation (via the wrapped repository).

Per the Sprint 10 rule _"only fix actual gaps"_, the canonical path was **not** rewritten. See next
section for the single gap addressed.

---

## 14. Canonical Consolidation Path

The only identified gap was **source-version awareness / stale detection**. `consolidation.service.ts`
`isSameConsolidation` now uses `sourcesMatch()`, which compares the provenance source _version
sets_ of the proposed target with the existing consolidated record:

- **Unchanged sources** → returns true → repeated consolidation remains a **no-op**
  (`recordsCreated: 0`, `conflicts: 1`), preserving the existing idempotency tests.
- **Changed sources** → returns false → the existing record is treated as stale and a conflict is
  surfaced instead of silently returning stale data. This is **safe retry**: the next run with the
  new source set produces the correct result.
- **Legacy records without provenance** still match (backward compatible).

Everything else stayed as-is per the non-destructive default behavior requirement.

---

## 15. Event Interaction

Persistence operations interact correctly with the existing audit event log:

- Successful durable write → `Created` (plus `Archived`/`Restored`/`Erased` per operation).
- Failed write → the error propagates; **no false success event** is emitted.
- **Idempotent create does not duplicate events** — identical replay emits `Retrieved`, not a
  second `Created`.
- **Concurrent identical creates** settle on one `Created`; the trailing caller emits
  `Retrieved`.
- Erase semantics from Sprint 9 remain intact (content-free `MEMORY_ERASED` tombstone).
- Event payloads remain sanitized (metadata-only); correlation IDs preserved.

The system is not event sourcing — the log remains an audit/event mechanism.

---

## 16. Failure Handling

- **Durable write failure** → `durableWrite` returns a result indicating no acknowledge; the
  caller must not report success (fail-closed).
- **Unregistered durable backend** → `MemoryConfigurationError` (never silent downgrade).
- **Cache unavailable / stale / invalidation failure** → the repository wrapper fails closed on
  writes that cannot invalidate; reads have no correctness dependency on the cache (the
  repository is the source of truth and the cache is a read-through optimization).
- **Conflict** → typed `MemoryConflictError`.
- No ACID guarantees are invented; the in-memory backend is non-transactional and this is
  documented rather than fabricated.

---

## 17. Recovery

- **Retry** — identical create is safe by design; conflicting create returns a typed error so a
  caller can correct the request. Repeated consolidation retries are no-ops.
- **Concurrent create recovery** — a caller that lost the namespace/key race returns the
  winner's record via the fingerprint fallback.
- **Restart/reload** — genuinely durable reload behavior is defined on the `DurableStorageAdapter`
  boundary (`reload()`) but is **not** implemented because no real durable backend exists. Sprint 10
  is explicit that process-local in-memory data is **lost on restart**.

---

## 18. Security

- Namespace isolation (idempotency registry, cache keys, durable capability scoping).
- Ownership + authorization enforced at the service for every read and write (unchanged).
- Idempotency-key isolation across namespaces (guard key + registry are namespace-scoped).
- Cache isolation (namespace-scoped, cloned values, no global auth caching).
- No sensitive values in cache metrics/logs/events.
- Erase invalidates cache; erased records cannot return through the cache.
- Restored records reflect current lifecycle state (cache invalidated on restore).
- Version conflicts are safe (update invalidates stale versions).
- Existing Sprint 3 and Sprint 9 security tests still pass (verified in the full suite).

---

## 19. Testing

48 new tests in `tests/unit/agents/ag-002-memory-manager/sprint10.test.ts` covering:

- Durable storage contracts (adapter/registry/result capability).
- Backend capability detection (durable vs. non-durable).
- Persistence configuration (schema defaults + factory routing + fail-closed).
- Idempotent create: first create, identical retry, conflicting retry, different namespace,
  missing key, malformed key, repeated key, event duplication prevention, version behavior.
- Concurrent identical creates (in-flight guard → one record).
- Cache: hit/miss, TTL, LRU bound/eviction, disabled mode, metrics.
- Cached repo: clone immutability, update/save/eraseById/eraseByNamespace invalidation,
  namespace-safe keys.
- Consolidation canonical/non-destructive path + stale-source detection.
- Fingerprint/digest/registry unit behavior.

All previous tests continue to pass — none deleted or weakened.

---

## 20. Quality Gates

| Gate      | Baseline (Sprint 9) | Current (Sprint 10) | New errors |
| --------- | ------------------- | ------------------- | ---------- |
| Tests     | 1108                | **1156 (+48)**      | 0          |
| Typecheck | 18 pre-existing     | 18 pre-existing     | 0          |
| Lint      | 27 pre-existing     | 27 pre-existing     | 0          |
| Build     | 2 pre-existing      | 2 pre-existing      | 0          |

Zero new typecheck/lint/build errors were introduced. All pre-existing errors live in files Sprint
10 was instructed not to touch (`retrieval/scorer.ts`, `retrieval/*`, `retrieval.service.test.ts`).

---

## 21. Performance

- `getById`/`get` hits avoid repository- and storage-layer work (read-through cache).
- The cache is bounded (default 512 entries) with TTL (default 60s), so it cannot grow unbounded
  and self-expires.
- Metrics (`hits`/`misses`/`evictions`/`expired`) give observability for tuning.
- Fingerprint/digest is O(content) with a stable FNV-1a hash; in-flight guard adds a single map
  lookup per idempotent create.

---

## 22. Known Limitations

- **No real durable backend exists.** Sprint 10 provides the contract and boundary only. Choosing
  `MEMORY_STORAGE_BACKEND=durable` fails closed. Process-local data is lost on restart.
- Idempotency registry is **process-local** — cross-restart idempotency requires the durable
  boundary (deferred, not faked).
- The in-memory repository is non-transactional (no invented ACID).
- Cache lives inside the process; it is an optimization, not a consistency mechanism.

---

## 23. Sprint 11 Deferrals

Deliberately NOT implemented (per scope rule):

- AG-001 runtime wiring.
- Dead-flag cleanup.
- Public-barrel / test-double hygiene.
- Registry-driven durable backend wiring (a real provider would register here).

---

## 24. Architecture Compliance

- Reuses existing contracts (`MemoryStorageAdapter`, `MemoryRepository`, `StorageCapability`,
  `MemoryCreateHeaders`, events, lifecycle, config).
- No AG-001 source modified; no AG-003/AG-004; no LLM/vector/external-API/payment integration.
- No new framework or dependency introduced for cache/idempotency/durability.
- Truthful durability claims: the boundary is real; persistence is not falsely asserted.

---

## 25. Final Verification

Run at Sprint 10 completion:

- `npx vitest run` → **1156 passed (87 files)**.
- `npx tsc --noEmit` → 18 pre-existing errors only (0 new).
- `npx eslint src tests` → 27 pre-existing errors only (0 new).
- `npx tsc -p tsconfig.build.json --noEmit` → 2 pre-existing errors only (0 new).

**Do not claim production durability**: no real durable backend is integrated or tested. Sprint 10
delivers the durable contract, the fail-closed boundary, idempotent create, the cache layer, and
canonical consolidation with stale-source detection — all verified and green.
