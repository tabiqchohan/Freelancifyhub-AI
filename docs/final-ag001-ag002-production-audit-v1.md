# FINAL AUDIT — AG-001 + AG-002 Production-Readiness Audit (v1)

**Date:** 2026-08-30
**Scope:** AG-001 Master Orchestrator (Sprints 1–9) + AG-002 Memory Manager (Sprints 1–11) + technical-debt cleanup
**Method:** Read-only verification against actual source (no code/tests/config modified). Claims validated by `file:line` evidence.

---

## 1. Executive Summary

AG-001 and AG-002 are **exceptionally well-engineered components** with professional structure, honest fail-closed boundaries, comprehensive isolated test suites (1172 tests passing), and zero typecheck/lint/build errors. The technical-debt cleanup (commit `2105fe1`) is genuinely effective.

**However, the system is NOT production-ready.** It is a high-quality **library of components**, not a deployed runtime. The decisive findings:

1. **No real durable persistence backend exists** — everything (storage, cache, idempotency, event log) is process-local in-memory. `MEMORY_STORAGE_BACKEND=durable` is guaranteed to crash (empty backend registry).
2. **AG-001 → AG-002 is NOT wired at runtime** — no production composition root constructs the orchestrator or memory manager; `src/index.ts` boots only a `/healthz` HTTP stub.
3. **AG-001 execution has no real executors** — the `ExecutionEngine` default registry returns `undefined`, so every step fails `AGENT_EXECUTOR_UNAVAILABLE`.
4. **A security bug exists in the retrieval pipeline** — the scope and security-clearance filters are computed and logged but **discarded**; results are never filtered by them.
5. **The audit/event log is never wired to any producer at runtime** — tombstone/security events land only in an in-memory emitter.

---

## 2. Audit Scope

- AG-001 Master Orchestrator (Sprints 1–9): Foundation, Intent, Context, Routing, Planning, Execution, Aggregation, Hardening, MasterOrchestratorService, runtime flow, dead paths.
- AG-002 Memory Manager (Sprints 1–11): CRUD, Lifecycle, Security, Retrieval, Context Integration, Consolidation, Persistence/Storage, Cache, Event Log, DSR, Orchestration Integration, Idempotency, Replay.
- Technical-debt targets: typecheck/lint/build = 0, tests passing.
- Cross-cutting: security/redaction, performance/scalability, API/architecture, configuration, test quality.

## 3. Repository Baseline (fresh, with `NODE_OPTIONS=--max-old-space-size=8192`)

| Check                       | Result                                                         |
| --------------------------- | -------------------------------------------------------------- |
| `git status`                | Clean (only untracked `prompts/*`)                             |
| `git log -10`               | Cleanup commit `2105fe1` present ("AG-002 zero-error cleanup") |
| `npm run typecheck`         | **0 errors** (pass)                                            |
| `npm run lint` (`eslint .`) | **0 errors** (pass)                                            |
| `npm run build`             | **Success** (pass)                                             |
| `npm test`                  | **1172 passed** (89 files)                                     |

> Note: Without an increased heap the Node processes OOM in this shell (`Zone Allocation failed`, exit 134); this is an environment heap-limit artifact, not a code issue. The direct `npx` runs and the heap-bumped `npm run` all pass cleanly.

---

## 4. AG-001 Findings

The 9-stage runtime chain (INPUT → VALIDATION → INTENT → CONTEXT → ROUTING → PLANNING → EXECUTION → AGGREGATION → RESPONSE) is **authentically wired in source** — every engine is a real concrete class wired via the service's DI (`orchestrator/services/master-orchestrator.service.ts:127-375` runs all stages in order; integration test `integration.test.ts` exercises the full real pipeline).

| Component                 | Status                                       | Evidence / Notes                                                                                                                                                                                                                                                                |
| ------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Foundation                | PASS                                         | `validators/agent.validator.ts`, `config/schema.ts`; used by service                                                                                                                                                                                                            |
| Intent Detection          | PASS                                         | `RuleBasedIntentClassifier` (`intent/classifiers/index.ts:35`) wired at runtime; role-filtering, low-confidence UNKNOWN fallback, determinism                                                                                                                                   |
| Context Builder           | PASS (built-in) / **DEAD (memory provider)** | `context/builders/index.ts:36` assembles supplied items; BUT `MemoryContextProviderAdapter`/`createMemoryContextProvider` (`context/memory/memory-context-provider.ts:33,142`) are exported but **never invoked in runtime** — AG-002 memory not fed into context               |
| Routing                   | PASS                                         | `RoutingEngine` (`routing/engine.ts:56`); draft/retired filtering (`matchers/index.ts:12-21`, `ROUTABLE_STATUSES`), availability, fallback, escalation, confidence, cost all enforced. **PARTIAL:** `allowedRoles` matcher branch (`matchers/index.ts:51-56`) is an empty no-op |
| Execution Planning        | PASS / **PARTIAL**                           | `ExecutionPlanBuilder` (`planning/builders/index.ts:42`); constraints/limits enforced. Sequential & Conditional modes **unreachable via default routing** (`resolveExecutionMode` yields only Single/Parallel/Hybrid)                                                           |
| Execution Engine          | PASS (machinery) / **PARTIAL (executors)**   | Retry/timeout/cancellation/concurrency/conditional all concrete. **CRITICAL:** default executor registry = `{ resolve: () => undefined }` (`execution/engine/index.ts:66`) → every step fails `AGENT_EXECUTOR_UNAVAILABLE`; only Fake/Static test executors exist               |
| Aggregation               | PASS                                         | `SharedAggregationService` wired; dedup, retry history, sanitize. **DEAD export:** per-mode aggregators + `resolveAggregationStrategy` (`aggregation/aggregators/index.ts:156-204`) never called                                                                                |
| Hardening                 | PASS                                         | retry/timeout/cancellation/concurrency/conditions + routing fallback/escalations all concrete and wired                                                                                                                                                                         |
| MasterOrchestratorService | PASS                                         | DI + `assertDependencies` fail-closed (`service.ts:386-404`); typed errors, event correlation (`services/events.ts`), cancellation, determinism                                                                                                                                 |

**Dependency injection / error propagation / typed errors / event correlation / determinism / sanitization:** PASS (see roll-up in section 4 above).

**Dead / unused surfaces (AG-001):**

- `services/dependency-container.ts` (`DependencyContainer`, `ServiceKey`) — exported, interface-only, **no usages** (DEAD).
- `interfaces/pipeline.ts` (`PipelineStep/Stage/Result/PipelineExecutor`) — exported, **no usages** (DEAD).
- `builders/execution-context.builder.ts` + `builders/response.builder.ts` — test-only, not used in runtime flow (DEAD-in-runtime).
- `aggregation/aggregators/index.ts:156-204` per-mode aggregators — never called (DEAD).
- `context/memory/memory-context-provider.ts` + `context/interfaces/providers.ts` — exported but not wired (DEAD carrier of the AG-002 import).
- `routing/matchers/index.ts:51-56` `allowedRoles` — dead no-op branch.

---

## 5. AG-002 Findings

### Memory CRUD

PASS overall: create/read/update/delete, versioning, optimistic/version-safe updates, namespace isolation, ownership (`services/memory.service.ts`). **RISK:** the non-version-guarded `save` path is used by soft-delete/archive/consolidation paths — version-safety is not uniform across all write paths.

### Lifecycle

PASS: Active/Archived/Expired/Deleted/Restore, TTL, lifecycle evaluation/events. **RISK (PARTIAL determinism):** `isMemoryExpired` uses `new Date()` by default (`retention/index.ts:22`, called from `memory.service.ts:533/560/714`), bypassing the injected `Clock` — violates the clock abstraction's own rule (`clock/index.ts:2-3`).

### Security

PASS for the matrix/namespace mechanism (`security/index.ts`, fail-closed patterns), plus sanitization (`utils/sanitize.ts`) + prototype-pollution guard (`utils/serialization.ts:6-29`). **HIGH RISKS:**

- **RISK-C1:** the retrieval/query read path checks matrix + namespace only — ownership and security-clearance are not enforced there (single-record delete does enforce clearance at `memory.service.ts:1049-1058`, so the two read paths are inconsistent).
- **RISK-C2:** lifecycle transition checks use a weak matrix-only policy.
- **RISK-C3:** actor-supplied `reason`/`denialReason` are persisted unsanitized and queryable from the event log with **no authorization** (`events/query.ts:122-179`) — a secret in a reason can be read by any component holding the log reference.
- **RISK-C4:** retrieval snippet redaction (`retrieval.service.ts:320-337`) uses a narrow 3-regex approach that misses quoted JSON keys, short values, and multi-word values.

### Retrieval

**Runtime pipeline is real** (candidate retrieval → lifecycle filter → authorization → scope → security → scoring → ranking → dedup → limits → token budget → context → sanitization) EXCEPT:

- **CRITICAL BUG:** `scopeFiltered` (`retrieval.service.ts:102`) and `securityFiltered` (`retrieval.service.ts:107`) are computed and logged (`:104,:109`) but **discarded** — scoring runs on `authorized` (`:125`). Clearance enforcement exists only inside the injected `SecurityLevelPolicy`, not as a fail-safe here. (Verified: no further reference to either variable.)
- Retrieval candidate retriever does a full `repository.list()` + per-record scope filter (O(N·S)).

### Context Integration

PASS: authorization, lifecycle filtering, deterministic ordering, dedup, section limits, token budget, secret sanitization, immutable/deterministic output. **RISK:** uses a separate string-regex redactor (not the shared canonical one).

### Consolidation

PASS: candidate selection, namespace isolation, authorization, provenance, deterministic key, duplicate/idempotency, archive-source, stale-source, security. **RISK:** version/`save` path not version-guarded; discovery does full namespace list + per-record authorization.

### Persistence / Storage

**REAL DURABLE BACKEND: NO.**

- Real working **in-memory** adapter (`storage/in-memory.ts:29`), explicitly labelled test infrastructure.
- Full durable **contract** (`storage/durable.ts:49`) with fail-closed factory (`storage/factory.ts:33-36` throws on unknown backend).
- **BUT** `registerDurableBackend` has **zero production call sites** — registry is empty. `MEMORY_STORAGE_BACKEND=durable` always throws. (Only a test registers a `FakeDurableAdapter`.)
- **Do not claim ACID:** transactions are best-effort snapshot+rollback (`storage/in-memory.ts:157-185`); capabilities honestly omit durable/idempotent/transactional (`storage/capabilities.ts:82-91`).

### Cache

PASS (in-memory): TTL, LRU bounds, namespace-safe keys, clone-in/out, invalidation on create/save/update/delete/eraseById/eraseByNamespace (archive/restore/expire flow through save/update), disabled mode, metrics. Stale-data risk LOW.

### Event Log

Component PASS: append/appendBatch, monotonic sequence, ordering, namespace/key filtering, metadata sanitization (default), deterministic cursors with fail-closed decode.
**RUNTIME WIRING PARTIAL/DEAD:** `memory.service.ts` holds only a `MemoryEventEmitter` — never an `EventLogContract`. `createEventLogRecorder`/`InMemoryEventLog` are never attached to a producer in production `src/` (test-only). Audit events (including DSR tombstones) do **not** reach an event log at runtime; replay has no populated source.

### DSR / Right to Forget

Design & component PASS: erase by ID / namespace, authorization (namespace + access-matrix + ownership + clearance), physical removal, cache invalidation, tombstone (`MEMORY_ERASED` honored by replay, never reconstructed), no sensitive content in tombstones. **PARTIAL:** not reachable through any production entry point (no composition root).

### Orchestration Integration (AG-001 → AG-002)

**NOT REAL — interface/definition-only.** `MemoryManagerContractAdapter`, `OrchestrationMemoryServiceImpl`, `MemoryContextProviderAdapter`, `createMemoryManagerService` are all only defined/re-exported; every instantiation is test-only. No production composition root constructs them. AG-001 does **not** call AG-002 at runtime.

### Supporting services

- **Idempotency:** PASS component (namespace-scoped, in-memory registry). In-memory only — lost on restart.
- **Write-back:** policy-only (`NONE` default), no persistence performed (honest boundary).
- **Replay:** PASS component (gated, deterministic, content-free, tombstone-aware) but no populated event log in production.

---

## 6. Security Audit (cross-system)

- Secret redaction is **not canonicalized** — three divergent implementations:
  1. `ag-002/utils/sanitize.ts:73-92` `redactSecrets` — recursive, non-mutating, `[REDACTED]`, `SECRET_KEY_PATTERN` heuristic. Best implementation; used in event-log metadata.
  2. `ag-001/aggregation/utils/index.ts:44-57` `sanitizeRecord` — key-strip (no placeholder), different key patterns.
  3. `ag-002/services/context-integration.service.ts:156-160` + `:604-613` — string-regex redactor on flattened text.
- **HIGH — retrieval snippet redaction bypass** (`retrieval.service.ts:332-334`): requires `apiKey: sk-…` with ≥20 chars (misses quoted `{"apiKey":"sk-abc"}`), `password: \S+` (misses quoted / multi-word), `\btoken\s*:` (misses `access_token`, `auth_token`, `api_key`).
- **MEDIUM — AG-001 orchestration event metadata not sanitized:** user-supplied cancel reason (`master-orchestrator.service.ts:122`), fallbackReason (`:176`), escalation.message (`:443`) are persisted raw into `InMemoryOrchestratorEventEmitter`; no AG-001 metadata redaction (unlike AG-002).
- **Positive:** `sanitizeMemoryRecordForLogs` (whitelist projection, no content) consistently used; logging in errors/metrics/health stays content-free; event-log append sanitizes metadata by default; `isSecretKeyName` is substring-based (over-redaction — safe direction, noisy).

---

## 7. Integration Audit

- Dependency direction **AG-001 → AG-002 only** — confirmed (AG-001 imports AG-002 types/contracts; grep of AG-002 for AG-001 imports → zero). **No circular dependency.**
- **BUT the integration is not runtime-active:** AG-001 never constructs/calls AG-002 in any production path; `src/index.ts` boots only the health stub server, importing neither agent.

## 8. Persistence Audit

- **REAL DURABLE BACKEND: NO.** Registry empty; default `in-memory`; `durable` config path throws. Process restart loses everything (storage, cache, idempotency, events).

## 9. Event / Replay Audit

- Event log component is correct, but **not wired to any producer at runtime** → replay has no populated source in production. Replay component itself is sound (sequence/duplicate checks, tombstone-aware, content-free).

## 10. DSR Audit

- DSR implemented to a high standard (physical removal, cache invalidation, tombstones, authorization incl. ownership + clearance, no content in tombstones) but **unreachable in production** (no entry point).

## 11. Cache Audit

- PASS (in-memory). TTL/LRU/clone-safe keys/comprehensive invalidation/disabled mode/metrics. Low stale-data risk. Non-durable (process-local).

## 12. Performance Audit (RISKS ONLY — not optimized)

- **Unbounded growth:** idempotency registry Map (`services/idempotency.ts:25`), event log `stored` array (`events/log.ts:131`), `InMemoryMemoryEventEmitter.recorded`, AG-001 `traceIds`/`cancellations` Maps (never deleted, `master-orchestrator.service.ts:84-86,108,131`), `InMemoryOrchestratorEventEmitter.recorded`.
- **Full scans:** retrieval candidate-retriever `list()` + per-record filter; retrieval/in-memory engine `search()`; event log `query()` O(n) per page + cursor rescans + `count()` full scan; replay pages whole log per key.
- **Excessive serialization/cloning:** `structuredClone` on every storage read/write/list + transactional snapshot/rollback; content stringified up to 3× per candidate per retrieval; O(queryTokens × contentTokens) scorer.
- **Bounded positives:** result/event/cache caps exist, but they don't bound the scan cost to reach them.

## 13. Configuration Audit

All AG-001 and AG-002 config flags inspected. No dead flags found in AG-002; AG-001 config surface is consumed by its service.

| Flag                                                      | DEFINED | READ | EFFECTIVE                             | STATUS                 |
| --------------------------------------------------------- | ------- | ---- | ------------------------------------- | ---------------------- |
| `MEMORY_STORAGE_BACKEND` (default `in-memory`)            | Yes     | Yes  | In-memory effective; `durable` throws | PARTIAL (durable dead) |
| `MEMORY_STORAGE_DURABLE_BACKEND` (default `''`)           | Yes     | Yes  | No registered backend                 | PARTIAL                |
| `MEMORY_CACHE_*` (enabled/ttl/entries)                    | Yes     | Yes  | Effective                             | PASS                   |
| `MEMORY_RIGHT_TO_FORGET_ENABLED` (default true)           | Yes     | Yes  | Effective (component)                 | PASS (no prod entry)   |
| `MEMORY_EVENT_LOG_REPLAY_ENABLED`                         | Yes     | Yes  | Effective (component)                 | PASS (no prod source)  |
| `MEMORY_ORCHESTRATOR_INTEGRATION_ENABLED` (default false) | Yes     | Yes  | Effective                             | PASS (off by default)  |
| `MEMORY_ORCHESTRATOR_WRITE_BACK` (default `NONE`)         | Yes     | Yes  | Policy only                           | PASS                   |
| AG-001 config (execution concurrency, routing caps, etc.) | Yes     | Yes  | Effective                             | PASS                   |

## 14. API / Architecture Audit

- **Dead / misleading exports:** `dependency-container.ts`, `interfaces/pipeline.ts`, `aggregation` per-mode aggregators, `context/memory/memory-context-provider.ts` (dead runtime), base `ResponseBuilder`/`ExecutionContextBuilder`, dead `allowedRoles` matcher branch.
- **Leaked test doubles / in-memory infra in public barrels:** `ag-002/index.ts:23-25` exports `InMemoryStorageAdapter`, `InMemoryMemoryRepository`, `InMemoryMemoryRetrievalEngine` as the **default public** storage/repository/retrieval surface; `InMemoryMemoryEventEmitter`, `InMemoryEventLog`/`createEventLog` reachable through barrel re-exports. `StubMemoryManagerContract` (test double) lives in `src/agents/ag-002-memory-manager/orchestration/test-doubles.ts` (not re-exported — acceptable, but production-tree location).
- **No accidental AG-003/AG-004 implementation** — only scaffold provider interfaces + placeholder agent IDs.
- **Three sanitizer contracts duplicated** across packages instead of one shared module.
- **No `src/agents/index.ts`** composition root; AG-002 requires client to inject everything (incl. `authorizationService`, which has no default → unwired instance throws).

## 15. Test Quality Audit

- **No skipped / `.only` / TODO tests** found.
- Strong security suites: `security-regression.test.ts` (matrix lockdown), `event-log.test.ts` (redaction), `context-integration.service.test.ts` (leak matrix), `sprint9.test.ts` (tombstones).
- **HIGH — test encodes the security-filter bug as expected behavior:** `retrieval.service.test.ts:326-328` comment says CONFIDENTIAL "should be excluded" but asserts `['CONFIDENTIAL','INTERNAL']` — passes only because `securityFiltered` is discarded. Regression not caught.
- **MEDIUM — timing-dependent tests** with real timers (concurrency/cancellation/stress/timeout/integration) racing 2–15 ms against 40 ms fake-executor delays — flaky under CI load.
- **MEDIUM — redaction tests only exercise regex-friendly formats** — the JSON-quoted snippet bypass is uncovered.
- **MEDIUM — AG-001↔AG-002 integration tested only via stubs** (`memory-context-provider.test.ts` uses a hand-rolled `StubContract`), never the real adapter chain.
- **Coverage gaps:** no test asserts the discarded security/scope filters ever bind; no growth/retention tests for unbounded stores; no concurrent-create race test on the idempotency registry.

---

## 16. Critical Findings

| ID     | Severity | Component        | Finding                                                                                     | Evidence                                                                                                         | Impact                                                                     | Recommended action                                                    |
| ------ | -------- | ---------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| CRIT-1 | CRITICAL | AG-002 Retrieval | Scope + security-clearance filters computed but **discarded**; results never filtered       | `services/retrieval.service.ts:102,107` computed; only `authorized` used at `:125`                               | Unauthorized/low-clearance memory may be **returned** in retrieval results | Apply `scopeFiltered`/`securityFiltered` to results; add a fail-safe  |
| CRIT-2 | CRITICAL | Persistence      | **No real durable backend**; durable registry empty; `durable` config crashes               | `storage/durable.ts:79-107`; factory `storage/factory.ts:33-36`; no `registerDurableBackend` call site in `src/` | All state lost on restart; "durable" contract is façade                    | Implement a real durable backend (file/DB) or document in-memory-only |
| CRIT-3 | CRITICAL | Orchestration    | **No runtime composition root** for AG-001 or AG-002; `src/index.ts` boots only health stub | `src/index.ts:5` (only `createAppServer`); no agent constructed in `src/`                                        | System not deployable; nothing executes end-to-end                         | Add a composition root wiring agents + providers                      |
| CRIT-4 | CRITICAL | AG-001 Execution | No real executors wired — default registry returns `undefined`                              | `execution/engine/index.ts:66` → `AGENT_EXECUTOR_UNAVAILABLE` at `lifecycle/index.ts:122`                        | No step can execute in the runtime                                         | Implement/wire real agent executors                                   |
| CRIT-5 | CRITICAL | AG-001↔AG-002    | Integration enforced only by tests; no production wiring                                    | `createMemoryContextProvider`/`MemoryManagerContractAdapter` instantiated only in tests                          | AG-001 cannot use AG-002 at runtime                                        | Compose the adapter chain in the composition root                     |
| CRIT-6 | CRITICAL | Event Log        | Audit log never wired to any producer at runtime                                            | `memory.service.ts` has no `EventLog` ref; recorder test-only                                                    | No durable audit trail; DSR tombstones unreachable; replay has no source   | Wire `createEventLogRecorder` to the emitter in composition root      |

## 17. High Findings

| ID     | Component        | Finding                                                                         | Evidence                                                                                               | Action                                                         |
| ------ | ---------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| HIGH-1 | AG-002 Security  | Retrieval/query read path skips ownership + clearance checks                    | `services/retrieval.service.ts` (matrix+namespace only); inconsistent w/ `memory.service.ts:1049-1058` | Enforce clearance/ownership on the read path                   |
| HIGH-2 | AG-002 Retrieval | Snippet redaction bypassable (quoted keys, short/multi-word values)             | `retrieval.service.ts:332-334`                                                                         | Use canonical recursive `redactSecrets`; add quoted-JSON tests |
| HIGH-3 | AG-002 Events    | `reason`/`denialReason` unsanitized + event log queryable without authorization | `events/query.ts:122-179`; `events/sanitize.ts:61-66`                                                  | Sanitize free-text fields; gate event-log reads                |
| HIGH-4 | AG-001 Context   | Memory/context provider exported but never wired → context has no memory        | `context/memory/memory-context-provider.ts:33,142`                                                     | Wire provider into ContextBuilder/service                      |
| HIGH-5 | Test Quality     | Test asserts the discarded-security-filter bug as expected behavior             | `retrieval.service.test.ts:326-328`                                                                    | Fix to assert exclusion (after CRIT-1 fix)                     |

## 18. Medium Findings

- **MED-1** Lifecycle TTL evaluates `new Date()`, bypassing injected clock (determinism) — `retention/index.ts:22`, `memory.service.ts:533/560/714`.
- **MED-2** Three divergent sanitizer implementations across packages — no shared canonical module.
- **MED-3** AG-001 orchestration event metadata (cancel reason, fallbackReason, escalation.message) not sanitized.
- **MED-4** Non-version-guarded `save` used in soft-delete/archive/consolidation paths.
- **MED-5** Sequential/Conditional execution modes unreachable via default routing.
- **MED-6** `allowedRoles` routing matcher branch is a dead no-op.
- **MED-7** Timing-dependent (flaky) tests with real timers.
- **MED-8** AG-001↔AG-002 integration tested only via stubs.

## 19. Low Findings

- **LOW-1** In-memory test doubles / infra exported from public barrels (`InMemoryStorageAdapter`, `InMemoryMemoryRepository`, etc.).
- **LOW-2** Test double `StubMemoryManagerContract` lives in `src/` tree.
- **LOW-3** `isSecretKeyName` substring-based → over-redaction (noisy but safe).
- **LOW-4** Idempotency registry in-memory only — lost on restart (documented).
- **LOW-5** No `src/agents/index.ts` composition root / requires manual injection.
- **LOW-6** Dead exports clutter barrels (pipeline, dependency-container, per-mode aggregators, base builders).

## 20. Deferred Items

- Real durable/database persistence (file/DB/S3/vector) — contract + adapter ready, backend not implemented.
- Real agent executors (tied to which agents ship) — execution engine ready, executors deferred.
- LLM/vector/database/payment integrations — out of AG-001/AG-002 scope (future AG-003/AG-004).
- Write-back semantics to external systems (policy `NONE` default reserved).

## 21. Final Gap Matrix

| Requirement                                | Status                | Evidence                                     | Remaining Work                       |
| ------------------------------------------ | --------------------- | -------------------------------------------- | ------------------------------------ |
| AG-001 runtime pipeline (9 stages)         | PASS                  | `master-orchestrator.service.ts:127-375`     | —                                    |
| AG-001 real executors                      | **MISSING**           | `engine/index.ts:66` default `undefined`     | Wire executors                       |
| AG-001 composition root / deployable entry | **MISSING**           | `src/index.ts` health stub                   | Composition root                     |
| AG-001 dead paths cleaned                  | PARTIAL               | dead barrels + `allowedRoles`                | Remove/repair                        |
| AG-002 CRUD + lifecycle + versioning       | PASS                  | `memory.service.ts`, `lifecycle.service.ts`  | Guard `save` paths                   |
| AG-002 security (matrix/namespace)         | PASS                  | `security/index.ts`                          | Enforce read-path clearance (HIGH-1) |
| AG-002 retrieval filtering                 | **CRITICAL BUG**      | discarded `securityFiltered`/`scopeFiltered` | Apply filters                        |
| AG-002 retrieval sanitization              | PARTIAL               | narrow snippet regex                         | Canonical redactor                   |
| AG-002 context integration                 | PASS                  | `context-integration.service.ts`             | —                                    |
| AG-002 consolidation                       | PASS                  | `consolidation.service.ts`                   | Version-guard save                   |
| AG-002 real durable backend                | **MISSING**           | empty registry                               | Implement backend                    |
| AG-002 cache                               | PASS (in-memory)      | `cache/repository.ts`                        | Durable later                        |
| AG-002 event log component                 | PASS                  | `events/*`                                   | Wire to producer (CRIT-6)            |
| AG-002 DSR                                 | PASS (component)      | `memory.service.ts:756-1058`, replay         | Production entry point               |
| AG-001↔AG-002 runtime integration          | **MISSING (runtime)** | adapter test-only                            | Compose at runtime                   |
| Dependency direction AG-001→AG-002         | PASS                  | grep                                         | —                                    |
| No accidental AG-003/AG-004                | PASS                  | grep                                         | —                                    |
| Typecheck / Lint / Build / Tests           | PASS                  | baseline                                     | —                                    |

## 22. Production Readiness Scores

**AG-001**

| Dimension                | Score /100 |
| ------------------------ | ---------- |
| Architecture             | 88         |
| Correctness              | 80         |
| Security                 | 82         |
| Testing                  | 84         |
| Performance              | 70         |
| **Production readiness** | **40**     |

**AG-002**

| Dimension                | Score /100 |
| ------------------------ | ---------- |
| Architecture             | 90         |
| Correctness              | 76         |
| Security                 | 74         |
| Testing                  | 87         |
| Performance              | 68         |
| **Production readiness** | **42**     |

**Combined Overall:** 41 /100

> Rationale: Scores reflect code/design quality but are **capitally reduced for production readiness** because there is no durable database, no runtime composition root, no real executors, no runtime AG-001↔AG-002 wiring, and a live retrieval authorization bug. Passing tests do not compensate for these.

## 23. Deployment Readiness

**NOT deployable as production.** The shipped server (`src/index.ts`) only answers `/healthz`; no agent executes, no memory persists, no retrieval runs. It is a compilable/testable library.

## 24. AG-003 Readiness

**No — not yet.** Starting AG-003 on top of an unwired, non-durable foundation would propagate the gaps. AG-003 work should wait until the composition root + durable persistence exist (see §26), unless it is intentionally being developed as interface work alongside an overdue infra sprint.

## 25. Final Recommendation

Treat AG-001 + AG-002 as **complete component libraries — NOT a complete production system.** Do not deploy or start AG-003 runtime work on this foundation yet. The single highest-leverage step is delivering one "production wiring" increment: real durable persistence, a composition root that constructs both agents, and enabled runtime integration — plus fixing the one live security bug (CRIT-1).

---

## 26. Next Steps (smallest possible roadmap)

1. **Fix CRIT-1** — apply the already-computed `scopeFiltered`/`securityFiltered` in `retrieval.service.ts` (hours).
2. **Wire real executors** into the AG-001 runtime composition.
3. **Composition root** — construct AG-001 + AG-002 together and replace the health stub; enable `MEMORY_ORCHESTRATOR_INTEGRATION_ENABLED`.
4. **Real durable backend** — implement one `DurableStorageAdapter` and register it; implement durable idempotency/event-log tail.
5. Fix HIGH-1..HIGH-5 (read-path clearance, canonical redactor, event-log sanitize/auth, wire memory into context, fix the contradictory test).
6. Bound the unbounded in-memory structures (traceIds/cancellations/idempotency/event log) before memory is used long-lived.

### Direct answers

1. **Can we start AG-003 safely?** — **NO** (unwired + non-durable foundation).
2. **Can AG-001 use AG-002 in real runtime?** — **NO today** (no composition root; adapter test-only). Contract is ready.
3. **Can we deploy the current system?** — **NO** (health stub only).
4. **What infrastructure is still required?** — a durable persistence backend (file/DB), and (optional) an event-log sink; a real orchestration composition root.
5. **What MUST be fixed before production?** — CRIT-1 (retrieval auth bug), CRIT-2 (durable backend), CRIT-3/CRIT-5 (composition root + integration), CRIT-4 (real executors), CRIT-6 (audit wiring); plus HIGH-1/HIGH-2/HIGH-3.
6. **What can safely wait?** — MED/LOW items, consolidation/retention tuning, cache durability, AG-003/AG-004 interface scaffolding.

---

_End of audit. Intentionally NOT committed/pushed and no source/test/config modified, per audit instructions._
