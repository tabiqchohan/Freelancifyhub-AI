# AG-002 Shared Memory Manager — Sprint 1 Foundation

**Agent:** AG-002 · **Scope:** Sprint 1 — Foundation · **Status:** Implemented
**Source of truth:** `docs/shared-memory-architecture-v1.md` · **Task:** `prompts/prompts20`

## Summary

Sprint 1 delivers the typed, testable foundation for the Shared Memory Manager.
All architecture tables (memory types §4, lifecycle §5, ownership §6, access
matrix §7, retrieval §8, TTL/retention §9, events §16, config §17, storage tiers
§18) are encoded as source, and every operation in the `MemoryManager` contract
(prompt §14/§15) is implemented and covered by unit tests.

**Gates:** `npm run typecheck`, `npm run lint`, `npm test` (777 passing: 594 AG-001
baseline + 183 new), `npm run build` — all green.

## Deliverables

| Area               | Files                                                                                                                                                                       |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Enums              | `enums/index.ts` — 8 enums (11 memory types, 5 lifecycle states, priorities, security levels, permissions, ownership, actor groups, storage tiers)                          |
| Types              | `types/index.ts` — `MemoryRecord`, `MemoryRecordFilter`, `MemoryJsonValue` (recursive), `MemoryOwner`, `MemorySource`, `MemoryRetentionPolicy`, `MemorySizeLimits`, scalars |
| Errors             | `errors/index.ts` — `MemoryError` + validation, configuration, not-found, access-denied, lifecycle, retention, storage (retryable), retrieval, conflict                     |
| Config             | `config/schema.ts` + `config/index.ts` — env-validated `MEMORY_*` schema, defaults, `parseMemoryConfig`, `memoryConfig`                                                     |
| Schemas/validators | `schemas/index.ts` + `validators/index.ts` — Zod schemas + `validateMemoryRecord`, `validateTtl`, `validate*` scalars                                                       |
| Classification     | `classification/index.ts` — per-type default priority/security/retention/TTL/size cap (spec §4)                                                                             |
| Lifecycle          | `lifecycle/index.ts` — `MemoryLifecycleContract`, `DefaultMemoryLifecycle` (spec §5 state diagram)                                                                          |
| Retention          | `retention/index.ts` — `computeExpiry`, `isMemoryExpired`, `isMemoryLive`                                                                                                   |
| Security           | `security/index.ts` — `MemoryActor`, `MEMORY_ACCESS_MATRIX` (7×11), `MatrixMemoryAccessPolicy` (fail-closed), confidentiality helpers                                       |
| Storage            | `storage/index.ts` + `storage/in-memory.ts` — `MemoryStorageAdapter`, `tierForRecord`, `InMemoryStorageAdapter` (test-only)                                                 |
| Repositories       | `repositories/index.ts` + `repositories/in-memory.ts` — version-guarded `MemoryRepository` + `InMemoryMemoryRepository` (test-only)                                         |
| Retrieval          | `retrieval/index.ts` + `retrieval/in-memory.ts` — `MemoryRetrievalEngine` + deterministic in-memory engine (test-only)                                                      |
| Events             | `events/index.ts` — `MemoryEventType`, `MemoryEvent`, `MemoryEventEmitter`, `InMemoryMemoryEventEmitter`                                                                    |
| Service            | `services/memory.service.ts` — `MemoryManager` contract + `MemoryManagerService` + `createMemoryManagerService`                                                             |
| Tests              | `tests/unit/agents/ag-002-memory-manager/` — 16 files, 183 tests                                                                                                            |
| Docs               | `src/agents/ag-002-memory-manager/README.md`                                                                                                                                |

## Key Design Decisions

1. **Fail-closed authorization (AC-MEM-2).** `MatrixMemoryAccessPolicy.can()` requires
   both a matrix grant _and_ a matching entry in the actor's namespace allow-list.
   An actor with no allow-list is denied 100%.
2. **Matrix exactness.** `MEMORY_ACCESS_MATRIX` encodes spec §7 row-for-row:
   - AG-001: RWU short-term/session, read-only elsewhere, never deletes.
   - AG-002: full RWUD on most types; **write-only on user** (consent/retention);
     RW on knowledge references; read-only on session.
   - Client/Freelancer: RWU own-scoped user/conversation/project/temporary; write-only
     long-term; read-only on workspace/org/kb; never delete.
   - Marketing: RWU short-term/workspace/temporary; read-only elsewhere.
   - Marketplace: RWU project/temporary; RW knowledge refs; read-only elsewhere.
   - Admin: RWUD org/workspace/kb/long-term/archived; write-only user; read-only
     conversation/project.
     Conversation delete is held by **only** AG-002.
3. **Versioned updates (spec §15).** `updateMemory` takes `expectedVersion`; mismatch
   throws `MemoryConflictError` (409 semantics). Version bumps 1→2→3 monotonically.
4. **Lifecycle (spec §5).** `Created → Active` on persist; `Active → Archived|Expired|Deleted`;
   `Archived → Active|Deleted`; `Deleted` terminal. Invalid transitions throw typed errors.
   `DELETED` records are invisible to reads/retrieval (AC-MEM-4), and expired records are
   not returned.
5. **Test infrastructure is clearly isolated.** `InMemoryStorageAdapter`,
   `InMemoryMemoryRepository` and `InMemoryMemoryRetrievalEngine` are documented as
   test-only and fully replaceable via contracts.
6. **Events/log hygiene.** Events never carry content; logs pass through
   `sanitizeMemoryRecordForLogs` (no content/metadata, secret redaction).
7. **Immutability.** Every service/validator path clones on write and read; inputs and
   returned records are never mutated (verified by dedicated tests).
8. **TTL defaults.** Absent TTL now uses the per-type default from config (30d
   conversation, 15m temporary); `ttlMs: 0` disables expiry. (Implementation bug found
   during testing — `createMemory` was not applying defaults — fixed.)

## Intentional Deferrals

| Feature                                    | Spec ref | Status                                                                               |
| ------------------------------------------ | -------- | ------------------------------------------------------------------------------------ |
| Weighted relevance ranking formula         | §8       | Deferred; in-memory engine orders by priority then recency with deterministic scores |
| Vector/embedding search, hybrid search     | §8, §17  | Deferred (flag `MEMORY_HYBRID_SEARCH_ENABLED` exists)                                |
| Summarization / compression / recovery     | §5       | Deferred to summarization sprints; transient phases not stored                       |
| Real persistence (Postgres, Redis, Qdrant) | §18      | Deferred; contracts + test-only in-memory implementations                            |
| Identity provider / authN integration      | §7       | Deferred; actors carry `group` + `id` for future wiring                              |
| Cross-session event-log replay             | §16      | Deferred (flag `MEMORY_EVENT_LOG_REPLAY_ENABLED` exists)                             |

## Prompt Coverage

| Prompt area                                    | Status                 |
| ---------------------------------------------- | ---------------------- |
| §2 Memory types (11)                           | ✅                     |
| §3–§4 Attributes, classification defaults      | ✅                     |
| §5 Lifecycle states + transitions              | ✅                     |
| §6 Ownership                                   | ✅                     |
| §7 Access control + matrix                     | ✅                     |
| §8 Retrieval (contract + deterministic engine) | ✅ (ranking deferred)  |
| §9 TTL & retention                             | ✅                     |
| §10 Priority model                             | ✅                     |
| §11 Repository contract                        | ✅                     |
| §12 Storage tiers + contract                   | ✅                     |
| §13 Retrieval query/result contracts           | ✅                     |
| §14–§15 `MemoryManager` contract + operations  | ✅                     |
| §16 Events                                     | ✅                     |
| §17 Configuration                              | ✅                     |
| §18 Storage strategy                           | ✅ (provider deferred) |
| §19 Immutability                               | ✅                     |
| §20 Determinism                                | ✅                     |
| §21 Event-driven architecture / versioning     | ✅                     |
| §22 Serialization                              | ✅                     |

## Verification

- `npm run typecheck` — clean
- `npm run lint` — clean
- `npm test` — **777 passed** (594 baseline + 183 new AG-002)
- `npm run build` — clean
- No modifications to AG-001 source.

## Files Changed

- **Added:** `src/agents/ag-002-memory-manager/` (21 source files + README)
- **Added:** `tests/unit/agents/ag-002-memory-manager/` (16 test files + fixtures)
- **Untracked:** `prompts/prompts20` (task spec)
