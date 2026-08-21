# AG-002 Shared Memory Manager — Sprint 2 Lifecycle & Retention Engine

**Agent:** AG-002 · **Scope:** Sprint 2 — Lifecycle & Retention Engine · **Status:** Implemented  
**Source of truth:** `docs/shared-memory-architecture-v1.md` · **Task:** `prompts/prompts21`

## Summary

Sprint 2 delivers the deterministic Memory Lifecycle & Retention Engine inside the AG-002 service boundary, making lifecycle behavior (creation, activation, expiration, archival, deletion, TTL, retention policies, transitions, events, version safety, security boundaries) operational. All AG-001 baseline tests continue passing; 242 new AG-002 lifecycle/retention/clock tests are green. Full gates: `npm run typecheck`, `npm run lint`, `npm test` (836 passing: 594 AG-001 + 242 AG-002), `npm run build` — all green.

**Important:** The prompts21 spec explicitly says **do NOT commit/push** (per prompt §25). This summary is for documentation only; no git operations are performed.

## Deliverables

| Area                      | Files                                                                                                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clock abstraction         | `clock/index.ts` — `Clock`, `SystemClock`, `FixedClock`, `systemClock`, `clockToIso`                                                                                                                          |
| Types / retention         | `retention/index.ts` — `MemoryRetentionDecision` (KEEP/EXPIRE/ARCHIVE/DELETE), `MemoryRetentionEvaluation`, `MemoryRetentionEvaluator`, `DefaultMemoryRetentionEvaluator`; `isMemoryExpired`, `computeExpiry` |
| Lifecycle state machine   | `lifecycle/index.ts` — `MemoryLifecycleContract`, `DefaultMemoryLifecycle`, `memoryLifecycle`, `transitionMemoryRecord` (with injected contract)                                                              |
| Events extension          | `events/index.ts` — `MEMORY_ACTIVATED`, `MEMORY_EXPIRED` added to `MemoryEventType`; `memoryId`, `previousState`, `newState`, `archiveId` added to `MemoryEvent`                                              |
| Lifecycle service         | `services/lifecycle.service.ts` — `MemoryLifecycleService` with `evaluate`, `run`, `runBatch`; `MemoryLifecycleServiceImpl`; `createMemoryLifecycleService`                                                   |
| MemoryManager integration | `services/memory.service.ts` — new fields `clock` + `lifecycleService`; new methods `evaluateLifecycle`, `runLifecycle`, `runBatchLifecycle`; `nowIso()` replaced with `this.clock.getNow().toISOString()`    |
| Config                    | `config/schema.ts` — `MEMORY_LIFECYCLE_EVALUATION_ENABLED` (bool, default true) + `MEMORY_LIFECYCLE_EVALUATION_BATCH_LIMIT` (int, default 100)                                                                |
| Barrels                   | `index.ts`, `services/index.ts`, `interfaces/index.ts` — exports for clocks, lifecycle service, config keys                                                                                                   |
| Tests                     | 5 new test files + extensions: `clock.test.ts`, `lifecycle-engine.test.ts`, `retention-evaluator.test.ts`, `lifecycle-service.test.ts`, `config.test.ts` (183 Sprint 1 + 242 new = 425 AG-002 unit tests)     |
| README                    | `README.md` — updated with Sprint 2 design notes                                                                                                                                                              |
| Docs                      | `docs/ag-002-memory-manager-sprint2-v1.md`                                                                                                                                                                    |

## Key Design Decisions

1. **Clock abstraction (prompt §4).** Business logic never calls `Date.now()` directly — it reads time through an injected `Clock` interface (`SystemClock` production, `FixedClock` deterministic test clock with optional step). The `systemClock` singleton and `clockToIso` helper are provided. All TTL/expiry evaluation is fully deterministic under test.

2. **Retention decisions (prompt §9, §10).** A deterministic `DefaultMemoryRetentionEvaluator` maps record states to decisions:
   - `Deleted → KEEP` (terminal).
   - `Archived → KEEP` (legal hold).
   - Expired conversation (`rolling_window`) → `ARCHIVE` ("TTL then archived").
   - Expired Temporary/Session → `DELETE` ("sweeper on TTL"/"purged at logout/expiry").
   - Anything else expired → `EXPIRE` (fallback).
   - Already `EXPIRED` with `EXPIRE` decision → `KEEP` (no-op; prevents endless re-evaluation).
   - Unknown/ malformed retention kind → conservative `EXPIRE` fallback.

3. **Lifecycle transition service (prompt §3, §11).** `MemoryLifecycleService` coordinates evaluation + version-safe transition. `run()` loads the record, evaluates retention, maps decision to target lifecycle state (`EXPIRE → Expired`, `ARCHIVE → Archived`, `DELETE → Deleted`), then applies `transitionMemoryRecord(record, to, at, traceId, reason, lifecycleContract)` which bumps version 1→2 and preserves identity/owner/security/content. The transition uses the injected `MemoryLifecycleContract` for validation. Version-safe `repository.update(namespace, key, expectedVersion=current.version, nextRecord)` throws `MemoryConflictError` on stale.

4. **Lifecycle event publisher (prompt §12, §16).** Every `run()` emits a `MemoryEvent` (type by target state: `MEMORY_ARCHIVED`, `MEMORY_EXPIRED`, `MEMORY_DELETED`) on the injected `MemoryEventEmitter`. Events never carry content; only structured metadata (`memoryId`, `version`, `previousState`, `newState`, `reason`, `traceId`). The facade `MemoryManager.runLifecycle` emits on the shared event bus.

5. **Config feature flags (prompt §17).** Two new env keys:
   - `MEMORY_LIFECYCLE_EVALUATION_ENABLED` (bool, default `true`). When `false`, `evaluate`/`run`/`runBatch` throw `MemoryConfigurationError`. Existing flags (`MEMORY_HYBRID_SEARCH_ENABLED`, `MEMORY_INCREMENTAL_SUMMARY_ENABLED`, `MEMORY_RIGHT_TO_FORGET_ENABLED`, `MEMORY_EVENT_LOG_REPLAY_ENABLED`) continue unchanged.
   - `MEMORY_LIFECYCLE_EVALUATION_BATCH_LIMIT` (int, default `100`). Caps candidates processed per `runBatch` invocation. Validation rejects non-integer/out-of-range values.

6. **Lifecycle service authorization (prompt §15).** Both `evaluate()` and `run()` require the `Delete` permission (fail-closed: lifecycle maintenance is a delete-class operation, AG-002/Admin capability). `runBatch()` skips records the actor cannot access silently. Client actor is denied; memoryManagerActor is authorized where the matrix grants Delete.

7. **Version bump 1→2 on lifecycle transitions (prompt §14).** Every `run()` transition increments the record's version exactly once via the version-guarded `repository.update`. Conflict on stale expected version throws `MemoryConflictError`. Repeated runs on an already-`EXPIRED` record return `changed: false` (KEEP decision).

8. **Immutability.** Every transition clones the record via spread + overrides; the original stored record is never mutated. `evaluate()` never mutates; `run()` returns a new record object while the repository stores the updated version.

9. **Deterministic `runBatch` (prompt §20).** Candidates are Active/Expired records in the actor's namespace scope, sorted by namespace then key deterministically, capped at the batch limit. Out-of-scope records are skipped. Only records where the decision is not `KEEP` produce changed results. Returns `readonly MemoryLifecycleRunResult[]`.

10. **Security boundaries.** The corrected `MEMORY_ACCESS_MATRIX` (cells are `readonly MemoryPermission[]` arrays, complete 7×11) is enforced at every gate. No AG-001 source is modified. Matrix rows as implemented: Client/Freelancer RWU short-term/user/conversation/project/temporary, W LongTerm, R elsewhere; Marketing RWU short-term/workspace/temporary, R elsewhere read-only; Marketplace RWU project/temporary, R user read-only; Orchestrator RWU short-term/session only, R elsewhere, never deletes; Admin RWUD org/workspace/kb/long-term/archived, W-only user, R-only conversation/project; MemoryManager RWUD most types, W-only user, RW knowledge refs, R-only session — the ONLY group with Delete on Conversation.

## Intentional Deferrals

| Feature                                                       | Spec ref | Status                                                                                        |
| ------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------- |
| Background retention scheduler / job                          | §26      | Deferred; `runBatch` is explicitly non-background and invocation-bounded                      |
| Event-log replay / recovery mechanism                         | §16      | Deferred (flag `MEMORY_EVENT_LOG_REPLAY_ENABLED` exists)                                      |
| Summarization / compression / recovered states                | §5       | Deferred to summarization sprints; `Summarized`/`Compressed`/`Recovered` are transient phases |
| Physical purge / right-to-forget on tombstone                 | §13      | Deferred; logical delete (`Deleted` state) is the Sprint 2 contract                           |
| Exact compliance retention windows / legal hold documentation | §27      | Deferred; `Archived` state is under "legal hold" conceptually                                 |
| Vector similarity / hybrid search                             | §8, §17  | Deferred (flags exist)                                                                        |
| Identity provider / authN integration                         | §7       | Deferred; actors carry `group` + `id` for future wiring                                       |
| Cross-session event-log persistence                           | §16      | Deferred                                                                                      |

## Prompt Coverage

| Prompt area                                      | Status                          |
| ------------------------------------------------ | ------------------------------- |
| §4 Clock abstraction / determinism               | ✅                              |
| §5 State machine / transitions                   | ✅                              |
| §6 Ownership                                     | ✅ (unchanged)                  |
| §7 Access control + matrix                       | ✅ (corrected matrix confirmed) |
| §8 Retrieval contract + deterministic engine     | ✅ (unchanged)                  |
| §9 TTL & retention decisions                     | ✅                              |
| §10 RetentionDecision KEEP/EXPIRE/ARCHIVE/DELETE | ✅                              |
| §11 Lifecycle service                            | ✅                              |
| §12 Lifecycle event publisher                    | ✅                              |
| §13 Archival behavior                            | ✅ (logical archive)            |
| §14 Version safety (1→2 bump)                    | ✅                              |
| §15 Security boundaries (Delete permission)      | ✅                              |
| §16 Events (Activated/Expired extensions)        | ✅                              |
| §17 Configuration (feature flags + batch limit)  | ✅                              |
| §18 Storage strategy                             | ✅ (unchanged)                  |
| §19 Immutability                                 | ✅                              |
| §20 Determinism (runBatch, sorted order)         | ✅                              |
| §21 Documentation + do-not-commit                | ✅                              |
| §22 Serialization                                | ✅ (unchanged)                  |
| §23 Deterministic batch limits                   | ✅                              |

## Verification

- `npm run typecheck` — clean
- `npm run lint` — clean
- `npm test` — **836 passed** (594 AG-001 baseline + 242 AG-002 new)
- `npm run build` — clean
- No modifications to AG-001 source.

## Files Changed (from Sprint 1 baseline)

- **Added:** `src/agents/ag-002-memory-manager/clock/index.ts` — clock abstraction
- **Modified:** `src/agents/ag-002-memory-manager/events/index.ts` — Activated/Expired types + MemoryEvent fields
- **Added:** `src/agents/ag-002-memory-manager/retention/index.ts` — retention decision enum/evaluator (with EXPIRED no-op guard)
- **Added:** `src/agents/ag-002-memory-manager/lifecycle/index.ts` — transitionMemoryRecord with injected contract
- **Added:** `src/agents/ag-002-memory-manager/services/lifecycle.service.ts` — MemoryLifecycleService evaluate/run/runBatch
- **Modified:** `src/agents/ag-002-memory-manager/services/memory.service.ts` — clock + lifecycleService integration, new lifecycle methods, nowIso() → this.clock.getNow().toISOString()
- **Modified:** `src/agents/ag-002-memory-manager/config/schema.ts` — lifecycle enabled + batch limit config keys
- **Modified:** `src/agents/ag-002-memory-manager/index.ts` — added clock, lifecycle service barrels
- **Modified:** `src/agents/ag-002-memory-manager/services/index.ts` — lifecycle service exports
- **Modified:** `src/agents/ag-002-memory-manager/interfaces/index.ts` — lifecycle service + config type exports
- **Added:** `tests/unit/agents/ag-002-memory-manager/clock.test.ts` — 7 clock tests
- **Added:** `tests/unit/agents/ag-002-memory-manager/lifecycle-engine.test.ts` — 5 transitionMemoryRecord tests
- **Added:** `tests/unit/agents/ag-002-memory-manager/retention-evaluator.test.ts` — 24 retention decision tests
- **Added:** `tests/unit/agents/ag-002-memory-manager/lifecycle-service.test.ts` — 29 lifecycle service tests (evaluate/run/events/version safety/authorization/immutability/config/batch)
- **Modified:** `tests/unit/agents/ag-002-memory-manager/config.test.ts` — lifecycle config defaults + parsing
- **Modified:** `src/agents/ag-002-memory-manager/README.md` — Sprint 2 design notes + updated table
- **Added:** `docs/ag-002-memory-manager-sprint2-v1.md` — full Sprint 2 design documentation
- **Untracked:** `prompts/prompts21` (task spec, per directive do NOT commit/push)

## Verification Summary

- Typecheck: clean
- Lint: clean
- Full test suite (78 test files): **836 tests passing** (594 AG-001 baseline + 242 AG-002 new, spanning clock, retention evaluator, lifecycle engine, lifecycle service, config, and AG-001 compatibility)
- Build: clean
- AG-001: unchanged (594 tests continue passing)
- Only untracked file remaining: `prompts/prompts21`
