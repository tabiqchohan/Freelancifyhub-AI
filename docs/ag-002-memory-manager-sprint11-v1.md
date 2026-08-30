# AG-002 Memory Manager — Sprint 11 AG-001 RUNTIME WIRING + FINAL HYGIENE & INTEGRATION

**Sprint:** 11
**Status:** IMPLEMENTED
**Based on:** `prompts/prompts32` (AG-002 SPRINT 11 — AG-001 RUNTIME WIRING + FINAL
HYGIENE & INTEGRATION) + `prompts/audit-report-ag-002`.

---

## 1. Executive Summary

Sprint 11 closes the six gaps the Final Gap Audit assigned to Sprint 11 scope and
performs the final integration between AG-001 (Master Orchestrator) and AG-002
(Memory Manager) at the runtime seam:

1. **AG-001 → AG-002 runtime wiring** — a real `MemoryContextProviderAdapter` in
   AG-001 implements the AG-001 `MemoryContextProvider` in terms of the AG-002
   `MemoryManagerContract` (`retrieveService` → `buildContext` → mapped
   `ContextItem`s). The dependency is one-way (AG-001 → AG-002); AG-002 never
   imports AG-001, so there is no circular dependency.
2. **Public API no longer leaks the test-double contract** — `StubMemoryManagerContract`
   / `StubMetricSink` are removed from the `orchestration/` public barrel; the
   memory tests now import them directly from `orchestration/test-doubles.js`.
3. **`RetrievalServiceImpl` reachable from the public API** — exported from
   `services/index.ts` and the AG-002 root `index.ts` (plus `RetrievalServiceOptions`).
4. **Dead `interfaces/index.ts` barrel removed** — it had zero code imports; all its
   symbols remain reachable via the root barrel and module barrels.
5. **Four dead feature flags reduced to the two genuinely-dead ones** — the audit
   document was stale: `MEMORY_RIGHT_TO_FORGET_ENABLED` and
   `MEMORY_EVENT_LOG_REPLAY_ENABLED` are live gates (wired by Sprint 9). Only
   `MEMORY_HYBRID_SEARCH_ENABLED` and `MEMORY_INCREMENTAL_SUMMARY_ENABLED` were
   genuinely dead and were removed; tests were updated legitimately in line with
   their removal.
6. **Final integration verification** — a public-API smoke suite plus a full
   AG-001 adapter integration suite (11 adapter tests) confirm the wiring end to end.

Quality gates are preserved: the full suite passes (1172 tests, +16 new), and the
typecheck/lint/build baselines contain only pre-existing errors (18 / 27 / 2).

---

## 2. Scope

**In scope (Sprint 11 only):**

- AG-001 `context/memory/memory-context-provider.ts` — `MemoryContextProviderAdapter`
  - `createMemoryContextProvider` factory implementing the AG-001 provider contract.
- AG-001 `context/interfaces/providers.ts` — `MemoryContextLoadInput` contract and
  optional-`load(input)` on `MemoryContextProvider`.
- AG-001 `context/index.ts` — export the adapter, factory, options and load-input type.
- AG-002 retrieval public export (`services/index.ts`, root `index.ts`).
- AG-002 orchestration barrel hygiene (remove `test-doubles.js` re-export) + test
  import update.
- AG-002 dead `interfaces/index.ts` barrel deletion.
- AG-002 dead feature flags removal + `config.test.ts` update.
- 16 new tests (11 adapter integration + 5 public-API smoke/mapping checks).

**Out of scope (explicitly NOT implemented in Sprint 11):**

- AG-003 / AG-004, any LLM / vector / DB / social-media integration, payments, Stripe.
- Redesign of AG-001 or AG-002, or re-scoping the limits of the existing adapter.
- Fixing the pre-existing typecheck (18) / lint (27) / build (2) errors.
- Committing any `prompts/*` files (repo convention keeps prompt files untracked).

---

## 3. Baseline / Starting Point

Sprint 10 was committed (`b9dc12e`) and pushed to
`master` on `https://github.com/tabiqchohan/Freelancifyhub-AI.git`.

Baseline gates before Sprint 11:

- **Tests:** 1156 passing.
- **Typecheck:** 18 pre-existing errors (`retrieval/scorer.ts`, `retrieval.service.test.ts`).
- **Lint:** 27 pre-existing errors (retrieval tree + retrieval service + its test).
- **Build:** 2 pre-existing errors (`retrieval/scorer.ts`).

The Final Gap Audit listed four "dead" feature flags; Sprint 9 had since wired two of
them (`MEMORY_RIGHT_TO_FORGET_ENABLED` in `memory.service.ts:1067`,
`MEMORY_EVENT_LOG_REPLAY_ENABLED` in `replay.service.ts:122`), so only two were truly
dead at Sprint 11 start.

---

## 4. AG-001 → AG-002 Runtime Wiring

### 4.1 Adapter direction

AG-001 implements its own provider interface (`MemoryContextProvider`) in terms of
AG-002's `MemoryManagerContract`. The dependency is strictly one-way:

```
AG-001  context/memory/memory-context-provider.ts  →  AG-002  orchestration/manager-interface.ts
```

AG-002 never imports AG-001, so there is no circular dependency and AG-002 remains a
self-contained module.

### 4.2 Load input contract

`MemoryContextLoadInput` (defined in `context/interfaces/providers.ts`) carries the
request-scoped context that maps 1:1 to AG-002's authorisation and retrieval contracts:

- `actorGroup: MemoryActorGroup` (access matrix, spec §7)
- `namespaces: readonly MemoryNamespace[]` (fail-closed scope allow-list)
- `query`, `maxResults`, `contextBudgetTokens`, `maxRecordsPerSection`, `snippetLength`
- `securityClearance`, `actorId`, `actorRole`, `organizationId`, `workspaceId`, `projectIds`
- `requestId`, `traceId`

### 4.3 Adapter flow

1. Empty / no-namespace input → return `[]` immediately.
2. Build an AG-002 `MemoryActor` from the load input (group, scope, clearance, ids).
3. For **each** requested namespace, run the authorized retrieval pipeline
   (`contract.retrieveService`), then aggregate the deterministic `RetrievalResult`s.
4. Assemble them via `contract.buildContext` (redacted snippets, dedup, priority
   ordering, token-budget enforcement) — reusing AG-002's own safety engine.
5. Map each `ContextRecordEntry` to an AG-001 `ContextItem`:
   - `source: { type: MEMORY, id: namespace }`
   - `section: MEMORY`
   - `content: snippet`
   - `priority`: `MemoryPriority` → `ContextPriority`
     (Critical→CRITICAL, High→HIGH, Medium→NORMAL, Low→LOW)
   - `metadata`: recordId, namespace, key, type, securityLevel, tokenEstimate, version
   - `order`: stable deterministic ordering hint

---

## 5. Public API Hygiene

### 5.1 Retrieval reachability (audit gap #3)

`RetrievalServiceImpl` and `createRetrievalService` are now exported from
`services/index.ts` and the AG-002 root `index.ts`, together with the
`RetrievalServiceOptions` type. They are reachable from the public API surface.

### 5.2 Test-double leak removed (audit gap #2)

`export * from './test-doubles.js'` was removed from `orchestration/index.ts`.
`StubMemoryManagerContract` / `StubMetricSink` remain internal to
`orchestration/test-doubles.js`; `orchestration-memory.test.ts` now imports them from
that module directly. The public barrel no longer leaks test doubles.

### 5.3 Dead barrel removed (audit gap #4)

`src/agents/ag-002-memory-manager/interfaces/index.ts` had zero code imports (all
grep matches were AG-001's own interfaces or doc/prompt references). It was deleted
along with the now-empty `interfaces/` directory. All previously re-exported symbols
remain reachable via the root barrel.

### 5.4 Dead feature flags removed (audit gap #5)

`MEMORY_HYBRID_SEARCH_ENABLED` and `MEMORY_INCREMENTAL_SUMMARY_ENABLED` were removed
from `config/schema.ts`. `config.test.ts` was updated legitimately: the default-flag
assertion now checks the two live gates, the parse-values assertion no longer sets the
removed flag, and the invalid-boolean throw assertion uses a live flag.
`MEMORY_RIGHT_TO_FORGET_ENABLED` and `MEMORY_EVENT_LOG_REPLAY_ENABLED` are retained
as live gates.

---

## 6. Adapter Mapping

The adapter's mapping layer is deterministic and side-effect-free:

| AG-002 `MemoryPriority` | AG-001 `ContextPriority` |
| ----------------------- | ------------------------ |
| `Critical`              | `CRITICAL`               |
| `High`                  | `HIGH`                   |
| `Medium`                | `NORMAL`                 |
| `Low`                   | `LOW`                    |

Every mapped item uses `ContextSourceType.MEMORY` and `ContextSectionType.MEMORY`,
so downstream AG-001 context assembly can group and budget it uniformly.

---

## 7. Security

- **Fail-closed authorisation is retained**: the adapter always passes the actor's
  namespace allow-list into AG-002; AG-002's matrix + namespace-scope policies deny
  any namespace outside it. The integration test asserts records from namespaces
  outside the actor scope never leak into `ContextItem`s.
- **Security clearance propagation**: `securityClearance`, `organizationId`,
  `workspaceId`, `projectIds` are forwarded to the `MemoryActor`.
- **Redaction preserved**: snippets flowing into AG-001 items come from AG-002's
  `buildContext`, which already applies secret redaction at the trust boundary.
- **No credentials**: the adapter carries no secrets; AG-002's health/capability
  reporting remains secret-free.

---

## 8. Timeout / Cancellation

The adapter does not swallow AG-002 errors: a retrieval timeout/error or a
context-build cancellation/error propagates to the caller as a rejection. Two
integration tests cover propagation for both stages.

---

## 9. Error Handling

- No-namespace / empty input → deterministic empty result (`[]`), never an exception.
- Invalid input shapes are handled by AG-002's own validation (`MemoryValidationError`
  for missing actor/groups), which propagates unchanged.
- No new error types are introduced in Sprint 11; the adapter reuses AG-001's
  `ContextItem` surface and AG-002's validation.

---

## 10. Testing

16 new tests were added across two files:

- `tests/unit/agents/ag-001-master-orchestrator/context/memory-context-provider.test.ts`
  (11): empty-namespace, no-input, single-namespace mapping, multi-namespace iteration,
  all-four priority mapping, actor/scope propagation, security-clearance + id
  propagation, fail-closed namespace exclusion, retrieval timeout propagation,
  context-build cancellation propagation, empty-result mapping.
- `tests/unit/agents/ag-002-memory-manager/public-api-smoke.test.ts` (5):
  `RetrievalServiceImpl`/`createRetrievalService` reachable, AG-001 provider exposed,
  provider-factory source contract, dead flags absent, live gates present.

The AG-001 wrapper uses an in-scope `StubContract` implementing `MemoryManagerContract`
to drive the adapter deterministically.

---

## 11. Integration Verification

The public-API smoke suite confirms the audit gaps end to end:

- Retrieval service reachable from the AG-002 root barrel.
- AG-001 memory provider adapter + factory exported from `context/index.ts`.
- Dead flags removed from the parsed schema; live gates retained.
- The `orchestration/` barrel no longer re-exports test doubles downstream.

---

## 12. Files Changed

**Modified (8):**

- `src/agents/ag-001-master-orchestrator/context/index.ts`
- `src/agents/ag-001-master-orchestrator/context/interfaces/providers.ts`
- `src/agents/ag-002-memory-manager/config/schema.ts`
- `src/agents/ag-002-memory-manager/index.ts`
- `src/agents/ag-002-memory-manager/orchestration/index.ts`
- `src/agents/ag-002-memory-manager/services/index.ts`
- `tests/unit/agents/ag-002-memory-manager/config.test.ts`
- `tests/unit/agents/ag-002-memory-manager/orchestration-memory.test.ts`

**Added (3):**

- `src/agents/ag-001-master-orchestrator/context/memory/memory-context-provider.ts`
- `tests/unit/agents/ag-001-master-orchestrator/context/memory-context-provider.test.ts`
- `tests/unit/agents/ag-002-memory-manager/public-api-smoke.test.ts`

**Deleted (1):**

- `src/agents/ag-002-memory-manager/interfaces/index.ts` (+ the empty `interfaces/` dir)

**Untracked (not committed, repo convention):** `prompts/prompts30`, `prompts/prompts31`,
`prompts/prompts32`, `prompts/audit-report-ag-002`.

---

## 13. Known Limitations

- The adapter integrates AG-002 as the only memory provider; AG-003 / AG-004 providers
  are still interface-only, as scoped.
- `retrieval/*` pre-existing typecheck/lint/build errors remain untouched (out of scope).
- No real durable backend, LLM, or vector integration (not part of AG-002 today).

---

## 14. Sprint 12 Deferrals

Consistent with prior sprints, AG-003 (Knowledge), AG-004 (Tool), payments/Stripe,
and any real vector/LLM retrieval remain explicitly deferred and are not attempted.

---

## 15. Architecture Compliance

- **Seam discipline**: AG-001 depends only on the `MemoryManagerContract` interface,
  never on AG-002 implementation classes.
- **No circular dependency**: dependency is one-way AG-001 → AG-002.
- **Fail-closed** authorisation, security clearance, and redaction are preserved.
- **Deterministic** item mapping with stable ordering.

---

## 16. Final Verification

- **Tests:** 1172 passing (89 files; +16 new vs the 1156 baseline).
- **Typecheck:** 18 pre-existing errors only (no new).
- **Lint:** 27 pre-existing errors only (no new).
- **Build:** 2 pre-existing errors only (no new).
- **NUL-integrity:** no NUL-byte corruption in any edited/new file.
- **Repo search:** no stray references to the removed flags beyond the intentional
  smoke-test assertions; no dead-barrel or test-double-leak references in `src`.
