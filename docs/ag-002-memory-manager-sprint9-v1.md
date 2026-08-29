# AG-002 Shared Memory Manager — Sprint 9 RESTORE, EVENT REPLAY & DATA-SUBJECT ERASURE

**Sprint:** 9
**Status:** IMPLEMENTED
**Based on:** `docs/ag-002-final-gap-audit-v1.md` (Sprint 9 work packages: RESTORE, EVENT REPLAY, DSR ERASURE)

---

## 1. Executive Summary

Sprint 9 delivers the three capability closures identified as Sprint 9 scope by the final gap
audit:

1. **RESTORE** — a version-safe, authorized transition of an ARCHIVED memory back to ACTIVE, with
   idempotency and full lifecycle validation.
2. **EVENT-LOG REPLAY** — a deterministic, corruption-detecting reconstruction of a memory's
   lifecycle/version history from the sanitized audit event stream. Replay is explicitly
   erasure-aware: permanently erased memory is never reconstructed as active.
3. **DSR RIGHT-TO-FORGET / ERASURE** — physical erasure (stronger than soft-delete) of a memory by
   id or by namespace, gated by configuration, issuing a content-free `MEMORY_ERASED` tombstone.

All public entry points are gated by feature flags, fail closed on authorization, are idempotent,
and never place an erased payload into the audit stream. Quality gates are preserved: the full
suite (1108 tests) passes, and the typecheck/lint/build baselines contain only pre-existing errors.

---

## 2. Scope

**In scope (Sprint 9 only):**

- `restoreMemory` on the Memory Manager service + orchestration boundary wiring.
- Event-log replay (single key + namespace) with deterministic ordering and corruption detection.
- DSR erasure by id and by namespace with tombstone emission.
- Namespace/ownership/security isolation for all three operations.
- Idempotency and fail-closed behavior.
- 49 new tests covering restore, erasure and replay.

**Out of scope (explicitly NOT implemented in Sprint 9):**

- Durable database persistence, caching layers, AG-001 runtime wiring, AG-003/AG-004, and
  LLM/vector integration (Sprint 10).
- Hybrid/summary memory flags and test-double barrel hygiene (Sprint 11).
- Any change to `retrieval/scorer.ts`, `retrieval.service.test.ts`, or other pre-existing
  baseline files carrying known typecheck/lint errors.

---

## 3. Existing Architecture Reused

- `MemoryManager` service (`services/memory.service.ts`) — extended with restore/erase methods.
- Lifecycle engine (`lifecycle/index.ts`) — `DefaultMemoryLifecycle.canTransition`,
  `ALLOWED_TRANSITIONS` already define `Archived → Active` (restore) and treat `Deleted` as
  terminal.
- Access control (`security/index.ts`) — `MEMORY_ACCESS_MATRIX`, namespace scope, ownership and
  security-level policies, `DefaultAuthorizationService`.
- Event log/emitter (`events/log.ts`, `events/index.ts`) — `EventLogContract`, `InMemoryEventLog`,
  sanitized `StoredMemoryEvent` (metadata-only, never content).
- Repository/storage (`repositories/`, `storage/`) — in-memory adapters extended with erasure.
- Config (`config/schema.ts`) — dead feature-flag keys `MEMORY_RIGHT_TO_FORGET_ENABLED` and
  `MEMORY_EVENT_LOG_REPLAY_ENABLED` are now wired as live gates.

---

## 4. Restore Design

`MemoryManagerService.restoreMemory(input)`:

1. Validates namespace, key, reason, trace id.
2. Loads the record; **NotFound** when absent, `Deleted`, or live-expired (`expiresAt` passed) —
   permanently/locally removed memory is not restorable.
3. Authorizes with `MemoryPermission.Delete` (a delete-class/container privilege), the same
   permission used by `archiveMemory`; namespace/ownership/security constraints are enforced.
4. **Idempotent** when the record is already ACTIVE (returns it unchanged, no event, no version
   bump).
5. Validates the lifecycle transition `current → Active` via the lifecycle engine; an impossible
   source state throws `MemoryLifecycleTransitionError`.
6. Writes an ACTIVE record at `version + 1` and emits `MEMORY_RESTORED` with
   `previousVersion`.

---

## 5. Restore State Machine

Reuses the canonical transitions. Replay/restore legal paths include:

```
Archived ──restore──▶ Active
Deleted  ───────────▶ (terminal — NOT restorable)
Erased   ───────────▶ (physically absent — NOT restorable)
Expired  ───────────▶ (Expired → Active is NOT allowed by the lifecycle engine)
```

Restore therefore only ever moves `Archived → Active`. All other source states result in either
`NotFound` (Deleted/erased/expired-by-`expiresAt`) or a rejected transition.

---

## 6. Authorization Rules

| Operation          | Permission / gate                                            | Enforcement                                                                                                                                  |
| ------------------ | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Restore            | `MemoryPermission.Delete` (delete-class)                     | Matrix permission + namespace scope + ownership + security clearance via `authorize`; fail-closed                                            |
| Erase by id        | `Delete` matrix grant, namespace scope, ownership, clearance | Dedicated `assertCanErase` (deliberately bypasses generic lifecycle policy so already-soft-deleted records can be erased; still fail-closed) |
| Erase by namespace | Elevated group, namespace in actor scope, `Delete`           | `MemoryManager`/`Admin` groups only; namespace must be in actor allow-list                                                                   |

Cross-tenant erasure is impossible: an actor whose scope excludes the target namespace (or memory
namespace) is denied with an `EraseDenied` security event.

---

## 7. Event Replay Design

`services/replay.service.ts`:

- Pure, deterministic `replayMemoryStream(events, input)` reconstructs `{ state, version,
lastEventAt, events }` from an ordered stream, filtering strictly to `namespace+key`.
- `MemoryReplayService` (`replay` / `replayNamespace`) pages the `EventLogContract` using the new
  `namespace`/`key` query filters, gated by `MEMORY_EVENT_LOG_REPLAY_ENABLED`.
- Because `StoredMemoryEvent` carries only sanitized metadata, replay reconstructs **lifecycle
  state and version history only** — never content, secrets, or erased payloads.

---

## 8. Replay Ordering

- Events are consumed in log order (monotonic `sequence`).
- Version is tracked as the max seen across lifecycle/update events.
- `lastEventAt` is the timestamp of the final substantive event considered.
- Deterministic: identical input produces identical output (tests assert `toEqual` across repeated
  runs).

---

## 9. Replay Corruption Handling

Replay fails closed with `state === 'invalid'` and a descriptive `invalidReason` when it detects:

- Non-monotonic (out-of-order) `sequence`.
- Duplicate `eventId`.
- An impossible lifecycle transition implied by the stream (e.g. `Deleted → Archived`).

Invalid streams return the events considered so far, preserving the prefix for diagnosis. Replay
never re-sorts — it validates the supplied order.

---

## 10. Erasure Design

Two public operations, both **stronger than soft-delete** (physical removal, not a tombstone record):

- `eraseMemoryById(memoryId)` — removes the single record; idempotent no-op when already absent.
- `eraseMemoryByNamespace(namespace)` — removes every record in the namespace; emits a per-record
  tombstone.

Both are gated by `MEMORY_RIGHT_TO_FORGET_ENABLED`, validate `reason`, and emit a
`MEMORY_ERASED` tombstone carrying only `memoryId`/`namespace`/`key`/`reason` metadata — **no
content payload**.

---

## 11. Tombstone / Redaction Semantics

- Erasure issues `MEMORY_ERASED` (category `security`), not a delete lifecycle event, so the event
  stream, replay and retrieval all recognize it as permanent.
- The erased record is physically removed from the repository/storage, so it is inaccessible via
  `get`, `query`, `retrieval` and restore (`NotFound`).
- Replay honors the tombstone: encountering `MEMORY_ERASED` yields `state === 'erased'` and stops —
  **erased memory is never reconstructed as active**.
- The audit stream never contains the payload; `assertCanErase` denial paths emit `EraseDenied`.

---

## 12. Security Guarantees

- Fail-closed authorization on every entry point.
- Erasure requires elevated privileges (namespace scope + `MemoryManager`/`Admin` + `Delete`
  matrix grant + clearance for `Confidential` targets).
- Cross-tenant erasure is impossible; ownership is enforced.
- No erased content enters the event log; replay output is content-free.
- Disabled flags throw `MemoryConfigurationError` rather than silently proceeding.

---

## 13. Repository Changes

`repositories/index.ts` extends `MemoryRepository` with:

- `eraseById(id): Promise<boolean>`
- `eraseByNamespace(namespace): Promise<number>`

`repositories/in-memory.ts` implements both by delegating to storage removal.

---

## 14. Storage Changes

`storage/index.ts` extends `MemoryStorageAdapter` with:

- `removeByNamespace(namespace): Promise<number>`

`storage/in-memory.ts` implements physical removal of all records under a namespace prefix,
cleaning both the record and id-address maps.

---

## 15. Event Changes

`events/index.ts` adds event types:

- `MEMORY_RESTORED`, `MEMORY_ERASED`, `MEMORY_RESTORE_DENIED`, `MEMORY_ERASE_DENIED`.

`events/model.ts` maps the new types to `security`/`warning` (deny + erased) and lifecycle
categories.

`events/query.ts` adds `namespace`/`key` filters to `EventLogFilter` and `eventMatchesFilter`;
`events/log.ts` plumbs them into `query()` — enabling the replay service to page by key/namespace.

---

## 16. Idempotency

- `restoreMemory` on already-ACTIVE: returns unchanged, no event, no version bump.
- `eraseMemoryById` on absent record: returns `{ erased: 0, status: 'erased' }` (success, no throw).
- `eraseMemoryByNamespace` on empty namespace: returns `erased: 0`.
- Replay is a pure function of the stream — repeated invocation is deterministic.

---

## 17. Failure Handling

- `MemoryNotFoundError` for missing/deleted/erased/expired memory on restore.
- `MemoryAccessDeniedError` (+ `EraseDenied`/`AccessDenied` security event) on authorization
  failure.
- `MemoryLifecycleTransitionError` on impossible restore transitions.
- `MemoryConfigurationError` when a required feature flag is disabled.
- Repository/storage erasure failures surface as `MemoryStorageError`.

---

## 18. Test Coverage

New file `tests/unit/agents/ag-002-memory-manager/sprint9.test.ts` (49 tests):

- Restore: archived→active, authorization denial, NotFound (missing/deleted/erased), already-active
  idempotency, out-of-scope denial, impossible transition, invalid reason.
- Erase by id: physical removal, tombstone with no content, absent idempotency, scope denial,
  matrix-permission denial, disabled-flag, confidential clearance denial, `EraseDenied` event.
- Erase by namespace: multi-record removal + per-record tombstones, scope denial, non-elevated
  denial, disabled-flag, denial event.
- Replay (pure): empty, create, create→update (version tracking), create→archive, create→archive→
  restore, create→delete, create→expired, impossible transition, out-of-order, duplicate id,
  tombstone (erased, stop-at-tombstone, only-tombstone), determinism, content-free output, key
  isolation, `from` snapshot resume, lastEventAt.
- Replay (service): disabled flag, absent key, real-log create→archive→restore, real-log erased,
  `replayNamespace` multi-key, pagination (120 events), input validation.
- Orchestration wiring: restore no longer throws a deferred/unsupported error.

---

## 19. Quality Gates

| Gate                                 | Result                                                                                  |
| ------------------------------------ | --------------------------------------------------------------------------------------- |
| Full test suite                      | **1108 passed** (86 files) — baseline 1059 (85) + 49 new                                |
| New tests                            | 49 passed                                                                               |
| Typecheck (`tsc --noEmit`)           | 18 errors — all pre-existing baseline (retrieval/scorer.ts + retrieval.service.test.ts) |
| Lint (`eslint .`)                    | 27 errors — all pre-existing baseline (retrieval/ files)                                |
| Build (`tsc -p tsconfig.build.json`) | 2 errors — pre-existing baseline (retrieval/scorer.ts)                                  |

No baseline tests were deleted or weakened; no pre-existing baseline errors were introduced.

---

## 20. Known Limitations

- Restore authorization uses `MemoryPermission.Delete` (a delete-class privilege) rather than a
  dedicated matrix-issued `Restore` permission, because the access matrix defines no
  `Restore` grant — consistent with how `archiveMemory` already uses `Delete`.
- Erasure is implemented against the in-memory adapters; durable persistence and transactional
  guarantees belong to Sprint 10.
- `replayNamespace` returns a result for every key seen in a namespace, including non-lifecycle
  pseudo-keys (e.g. security `authorization-check` events resolve to `empty`).

---

## 21. Deferred Sprint 10 Work

- Durable database persistence and write-through CQRS storage.
- Caching layer (read-through / write-behind).
- AG-001 master-orchestrator runtime wiring of the memory subsystem.
- AG-003 and AG-004 integration.
- LLM / vector-store retrievable memory backends.

---

## 22. Deferred Sprint 11 Work

- Hybrid / summary memory feature flags.
- Test-double barrel hygiene (`interfaces/index.ts` dead barrel).
- Any remaining production-hardening not addressed by Sprint 9/10.

---

## 23. Architecture Compliance

- **Never reconstruct erased data** — erase → tombstone → `state === 'erased'`; restore of erased
  record is `NotFound`.
- **Erasure stronger than soft-delete** — physical removal, no soft-delete tombstone record, no
  payload in audit.
- **Deterministic replay** — monotonic ordering validated, duplicates/out-of-order/impossible
  transitions detected, output content-free.
- **Fail closed** — flags off, out-of-scope actors, low clearance all deny.
- **Isolation** — namespace/ownership/security enforced across restore, erasure and replay.

---

## 24. Final Verification

- [x] `restoreMemory` implemented
- [x] Restore authorization enforced
- [x] Restore lifecycle validation enforced
- [x] Event replay implemented
- [x] Replay deterministic
- [x] Replay corruption detected
- [x] Erasure implemented
- [x] Erasure is stronger than soft-delete
- [x] Erased memory inaccessible through get/query/retrieval/context
- [x] Erased memory cannot be restored
- [x] Replay cannot reconstruct erased memory
- [x] Audit event contains no erased payload
- [x] Namespace/ownership isolation enforced
- [x] Idempotency verified
- [x] Existing 1059 tests still pass
- [x] New Sprint 9 tests pass (49)
- [x] No tests deleted/weakened
- [x] No AG-001 source modified
- [x] No Sprint 10 implementation
- [x] No Sprint 11 implementation
- [x] Typecheck baseline preserved (18 pre-existing)
- [x] Lint baseline preserved (27 pre-existing)
- [x] Build passes (2 pre-existing)
- [x] Documentation written

---

## What Sprint 9 deliberately does NOT implement

- Sprint 10: durable DB persistence, caching, AG-001 runtime wiring, AG-003/AG-004, LLM/vector
  integration.
- Sprint 11: hybrid/summary flags and test-double barrel hygiene.
- Any modification to pre-existing baseline files carrying known typecheck/lint errors
  (`retrieval/scorer.ts`, `retrieval.service.test.ts`, etc.).
