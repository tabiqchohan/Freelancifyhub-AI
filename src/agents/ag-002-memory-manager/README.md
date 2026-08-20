# ag-002-memory-manager

Sprint 1 **Foundation** for the **AG-002 Shared Memory Manager** (catalog §10; blueprint §10;
see `docs/shared-memory-architecture-v1.md` and the prompt in `prompts/prompts20`).

## Purpose

This module owns the typed foundation of the shared memory system: the memory-type,
lifecycle, priority, security and access enums, the architecture access matrix
(spec §7), per-type classification defaults, TTL/retention helpers, validation,
the authorization contract, the repository/storage/retrieval contracts and the
coordinating `MemoryManager` service.

## Responsibilities

- Define strongly typed enums and record shapes for the eleven memory types.
- Implement the fail-closed access matrix and namespace-allow-list scope checks.
- Provide schema-driven validators for ids, owners, content, metadata, TTL and records.
- Provide deterministic lifecycle validation, retention/expiry helpers and typed errors.
- Provide a version-guarded repository abstraction and hot/warm/cold storage contract.
- Provide a `MemoryManager` coordinator (`createMemory`, `getMemory`, `updateMemory`,
  `deleteMemory`, `archiveMemory`, `retrieveMemory`) that emits correlated lifecycle events.

It does **not** do vector similarity, weighted relevance ranking, summarization/
compression, or real persistence — the in-memory storage/repository/retrieval
implementations are **test infrastructure only** and are replaced in later sprints.

## Current Sprint

**Sprint 1 — Foundation** (implemented). See `docs/shared-memory-architecture-v1.md`
and `docs/ag-002-memory-manager-sprint1-v1.md`.

| Sub-module        | Contains                                                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `enums/`          | `MemoryType` (11), `MemoryLifecycleState`, `MemoryPriority`, `MemorySecurityLevel`, `MemoryPermission`, `MemoryOwnerKind`, `MemoryActorGroup`, `StorageTier` |
| `types/`          | `MemoryRecord`, `MemoryRecordFilter`, `MemoryJsonValue`, `MemoryOwner`, `MemorySource`, `MemoryRetentionPolicy`, `MemorySizeLimits`, scalar types            |
| `errors/`         | `MemoryError` + validation, configuration, not-found, access-denied, lifecycle, retention, storage (retryable), retrieval, conflict                          |
| `config/`         | env-validated `MEMORY_*` config (`MemoryConfigSchema`), `parseMemoryConfig`, safe defaults, `memoryConfig`                                                   |
| `schemas/`        | Zod schemas for ids, owners, content (recursive JSON), metadata, records, filters, retention                                                                 |
| `validators/`     | `validateMemoryRecord`, `validateTtl`, `validateMemoryId/Namespace/Key/Owner/Actor/Content/...`                                                              |
| `classification/` | per-type default priority, security level, retention policy, TTL and size cap (spec §4)                                                                      |
| `lifecycle/`      | `MemoryLifecycleContract`, `DefaultMemoryLifecycle`, `memoryLifecycle`                                                                                       |
| `retention/`      | `computeExpiry`, `isMemoryExpired`, `isMemoryLive`                                                                                                           |
| `security/`       | `MemoryActor`, `MEMORY_ACCESS_MATRIX` (7×11), `MatrixMemoryAccessPolicy` (fail-closed), confidentiality helpers                                              |
| `storage/`        | `MemoryStorageAdapter` contract, `tierForRecord` + `InMemoryStorageAdapter` (test-only)                                                                      |
| `repositories/`   | `MemoryRepository` (version-guarded `update`) + `InMemoryMemoryRepository` (test-only)                                                                       |
| `retrieval/`      | `MemoryRetrievalEngine`/`Query`/`Result` + `InMemoryMemoryRetrievalEngine` (test-only, priority+recency order)                                               |
| `events/`         | `MemoryEventType`, `MemoryEvent`, `MemoryEventEmitter` + `InMemoryMemoryEventEmitter`                                                                        |
| `services/`       | `MemoryManager` contract, `MemoryManagerService`, `createMemoryManagerService`                                                                               |
| `index.ts`        | public barrel                                                                                                                                                |

## Design Notes

- **Fail-closed authorization** (AC-MEM-2): a decision passes only when both the
  matrix grants the permission _and_ the actor's namespace allow-list contains the
  target namespace.
- **Versioned updates** (spec §15): `updateMemory` requires `expectedVersion`; a
  mismatch is a `MemoryConflictError` (409 semantics).
- **Lifecycle**: `Created → Active` on persist; `Active → Archived/Expired/Deleted`;
  `Archived → Active/Deleted`; `Deleted` is terminal. Summarized/Compressed/Recovered
  arrive with the summarization sprints.
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
