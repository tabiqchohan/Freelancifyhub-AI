# ag-002-memory-manager

Sprint 1 **Foundation** + Sprint 2 **Lifecycle & Retention Engine** for the
**AG-002 Shared Memory Manager** (catalog §10; blueprint §10; see
`docs/shared-memory-architecture-v1.md` and the prompts in `prompts/prompts20`
and `prompts/prompts21`).

## Purpose

This module owns the typed foundation of the shared memory system: the memory-type,
lifecycle, priority, security and access enums, the architecture access matrix
(spec §7), per-type classification defaults, TTL/retention helpers, validation,
the authorization contract, the repository/storage/retrieval contracts and the
coordinating `MemoryManager` service. Sprint 2 adds a deterministic clock
abstraction and the operational lifecycle/retention engine.

## Responsibilities

- Define strongly typed enums and record shapes for the eleven memory types.
- Implement the fail-closed access matrix and namespace-allow-list scope checks.
- Provide schema-driven validators for ids, owners, content, metadata, TTL and records.
- Provide deterministic lifecycle validation, retention/expiry helpers and typed errors.
- Provide a version-guarded repository abstraction and hot/warm/cold storage contract.
- Provide a `MemoryManager` coordinator (`createMemory`, `getMemory`, `updateMemory`,
  `deleteMemory`, `archiveMemory`, `retrieveMemory`) that emits correlated lifecycle events.
- Provide a deterministic `Clock` abstraction so TTL and expiration evaluation is testable.
- Provide the `MemoryLifecycleService` (retention evaluation, version-safe transitions,
  deterministic bounded batch) exposed as `evaluateLifecycle`/`runLifecycle`/`runBatchLifecycle`.

It does **not** do vector similarity, weighted relevance ranking, summarization/
compression, real persistence, or run a background retention scheduler — the
in-memory storage/repository/retrieval implementations are **test infrastructure
only** and the lifecycle engine is invoked explicitly (no workers).

## Current Sprint

**Sprint 2 — Memory Lifecycle & Retention Engine** (implemented). See
`docs/shared-memory-architecture-v1.md` and `docs/ag-002-memory-manager-sprint2-v1.md`.

| Sub-module        | Contains                                                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `enums/`          | `MemoryType` (11), `MemoryLifecycleState`, `MemoryPriority`, `MemorySecurityLevel`, `MemoryPermission`, `MemoryOwnerKind`, `MemoryActorGroup`, `StorageTier` |
| `types/`          | `MemoryRecord`, `MemoryRecordFilter`, `MemoryJsonValue`, `MemoryOwner`, `MemorySource`, `MemoryRetentionPolicy`, `MemorySizeLimits`, scalar types            |
| `errors/`         | `MemoryError` + validation, configuration, not-found, access-denied, lifecycle, retention, storage (retryable), retrieval, conflict                          |
| `config/`         | env-validated `MEMORY_*` config (`MemoryConfigSchema`), `parseMemoryConfig`, safe defaults, `memoryConfig`                                                   |
| `schemas/`        | Zod schemas for ids, owners, content (recursive JSON), metadata, records, filters, retention                                                                 |
| `validators/`     | `validateMemoryRecord`, `validateTtl`, `validateMemoryId/Namespace/Key/Owner/Actor/Content/...`                                                              |
| `classification/` | per-type default priority, security level, retention policy, TTL and size cap (spec §4)                                                                      |
| `clock/`          | `Clock`, `SystemClock`, `FixedClock` (deterministic), `systemClock`, `clockToIso`                                                                            |
| `lifecycle/`      | `MemoryLifecycleContract`, `DefaultMemoryLifecycle`, `memoryLifecycle`, `transitionMemoryRecord`                                                             |
| `retention/`      | `computeExpiry`, `isMemoryExpired`, `isMemoryLive`, `MemoryRetentionDecision`, `MemoryRetentionEvaluation`, `DefaultMemoryRetentionEvaluator`                |
| `security/`       | `MemoryActor`, `MEMORY_ACCESS_MATRIX` (7×11), `MatrixMemoryAccessPolicy` (fail-closed), confidentiality helpers                                              |
| `storage/`        | `MemoryStorageAdapter` contract, `tierForRecord` + `InMemoryStorageAdapter` (test-only)                                                                      |
| `repositories/`   | `MemoryRepository` (version-guarded `update`) + `InMemoryMemoryRepository` (test-only)                                                                       |
| `retrieval/`      | `MemoryRetrievalEngine`/`Query`/`Result` + `InMemoryMemoryRetrievalEngine` (test-only, priority+recency order)                                               |
| `events/`         | `MemoryEventType` (incl. Sprint 2 `MEMORY_ACTIVATED`/`MEMORY_EXPIRED`), `MemoryEvent`, `MemoryEventEmitter` + `InMemoryMemoryEventEmitter`                   |
| `services/`       | `MemoryManager` contract + `MemoryManagerService`, `MemoryLifecycleService` + `createMemoryLifecycleService`                                                 |
| `index.ts`        | public barrel                                                                                                                                                |

## Design Notes

- **Fail-closed authorization** (AC-MEM-2): a decision passes only when both the
  matrix grants the permission _and_ the actor's namespace allow-list contains the
  target namespace.
- **Versioned updates** (spec §15): `updateMemory` requires `expectedVersion`; a
  mismatch is a `MemoryConflictError` (409 semantics). Lifecycle transitions also
  use the version-guarded `repository.update`, bumping the version by exactly one.
- **Lifecycle**: `Created → Active` on persist; `Active → Archived/Expired/Deleted`;
  `Expired → Archived/Deleted`; `Archived → Active/Deleted`; `Deleted` is terminal.
  Summarized/Compressed/Recovered arrive with the summarization sprints.
- **Retention decisions** (Sprint 2): a deleted record is `KEEP` (terminal); an
  archived record is `KEEP` (legal hold); an expired conversation (`rolling_window`)
  is `ARCHIVE`; an expired Temporary/Session is `DELETE`; anything else expired is
  `EXPIRE`. An already-`EXPIRED` record can only move forward to `ARCHIVE`/`DELETE`.
- **Lifecycle service authorization** (Sprint 2): `evaluate`/`run` require the
  `Delete` permission (delete-class maintenance, AG-002/Admin capability) and fail
  closed otherwise.
- **Clock** (Sprint 2): business logic never calls `Date.now()` directly; it reads
  through an injected `Clock` (production `SystemClock`, test `FixedClock`).
- **Events never carry content**; logs pass through `sanitizeMemoryRecordForLogs`.
- **TTL defaults**: absent TTL uses the per-type default from config
  (30d conversation, 15m temporary); `ttlMs: 0` disables expiry.

## Quality Gates

Run from the repository root:

```sh
npm run lint
npm run typecheck
npm test
npm run build
```
