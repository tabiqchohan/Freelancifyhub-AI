# AG-002 Shared Memory Manager — Sprint 8 Master Orchestrator Integration & Production Hardening

**Agent:** AG-002 · **Scope:** Sprint 8 — Master Orchestrator Integration & Production Hardening · **Status:** Implemented
**Source of truth:** `docs/shared-memory-architecture-v1.md` · **Task:** `prompts/prompts29`

## Summary

Sprint 8 integrates AG-002 into the Master Orchestrator (AG-001) as an **in-process seam**, without modifying any AG-001 code and without touching AG-002's existing Sprint 1–9 services. A new `orchestration/` capability module exposes a narrow, injectable **memory context service** and a **memory capability contract** that AG-001 depends on. The integration **reuses AG-002's real retrieval pipeline** (`RetrievalServiceImpl.retrieve`, via the manager contract adapter) and the **real ContextIntegrationService** `integrate()`, running both under bounded wall-clock timeouts, with fail-closed authorization, safe status mapping, aggregate-only metrics, truthful health/capability reporting, and correlated audit events. No AG-001 behavior, persistence contract, or existing emit site was modified.

Per the prompt, **this sprint is NOT committed or pushed.** All AG-001 + AG-002 baseline tests continue passing. 11 new Sprint 8 tests are green. Full gates: `npx vitest run` (**1059 passing** = 1048 baseline + 11 new), `npx tsc --noEmit` (18 pre-existing errors only), `npx eslint .` (27 pre-existing errors only), `tsc -p tsconfig.build.json` (clean) — no new errors introduced.

## Deliverables

| Area       | Files                                                                                                                                                                                                                                                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Contracts  | `orchestration/contracts.ts` — `MemoryContextStatus` enum, `OrchestrationMemoryRequest`, `MemoryContextResult`, `OrchestrationMemoryRecord`, `OrchestrationMemorySection`, `OrchestrationContextSection`, `MemoryFetchResult`, `MemoryContextAssemblyResult`, `MemoryWriteBackPolicy`, `OrchestrationMemoryCapabilities` |
| Error      | `orchestration/error.ts` — `MemoryIntegrationError`, `MemoryIntegrationErrorCategory`, `classifyIntegrationFailure`, `toMemoryIntegrationError`                                                                                                                                                                          |
| Timeout    | `orchestration/timeout.ts` — `withTimeout` (bounded wall-clock), `isCancelled`                                                                                                                                                                                                                                           |
| Metrics    | `orchestration/metrics-types.ts` (leaf `OrchestrationMemoryMetricsSnapshot` / `OrchestrationMemoryMetricSink`), `orchestration/metrics.ts` (`InMemoryOrchestrationMetrics`)                                                                                                                                              |
| Write-back | `orchestration/write-back.ts` — write-back policy plumbing (`NONE`/`EXPLICIT`/`EVENT_BASED`/`SELECTIVE`)                                                                                                                                                                                                                 |
| Health     | `orchestration/health.ts` — `OrchestrationMemoryHealth`, `buildIntegrationHealth`, `buildCapabilities`, `withMetrics`                                                                                                                                                                                                    |
| Contract   | `orchestration/manager-interface.ts` — `MemoryManagerContract`, `MemoryManagerContractHealth`, `MemoryManagerContractCapabilities`                                                                                                                                                                                       |
| Adapter    | `orchestration/memory-manager.ts` — `MemoryManagerContractAdapter` reusing real manager/retrieval/context/consolidation services                                                                                                                                                                                         |
| Service    | `orchestration/service.ts` — `OrchestrationMemoryServiceImpl`, `createOrchestrationMemoryService`, `requireActor`                                                                                                                                                                                                        |
| Utilities  | `orchestration/util.ts`, `orchestration/test-doubles.ts` (`StubMemoryManagerContract`, `StubMetricSink`)                                                                                                                                                                                                                 |
| Config     | `config/schema.ts` — `MEMORY_ORCHESTRATOR_INTEGRATION_ENABLED` (default `false`), `MEMORY_ORCHESTRATOR_RETRIEVAL_TIMEOUT_MS` (500), `MEMORY_ORCHESTRATOR_CONTEXT_TIMEOUT_MS` (250), `MEMORY_ORCHESTRATOR_WRITE_BACK` (default `NONE`) + constants                                                                        |
| Extension  | `orchestration/index.ts` barrel + `export * from './orchestration/index.js'` in the AG-002 main `index.ts`                                                                                                                                                                                                               |
| Tests      | `tests/unit/agents/ag-002-memory-manager/orchestration-memory.test.ts` — 11 tests (Sprint 8): feature gate, fail-closed auth, health/capabilities, correlation preservation, cancellation, timeout mapping, SecurityDenied mapping, redacted happy path, empty, and one real AG-002 pipeline integration                 |
| Docs       | `docs/ag-002-memory-manager-sprint8-v1.md` — this document                                                                                                                                                                                                                                                               |

## Sprint 8 Architecture

```
AG-001  ──(in-process seam)──▶  memoryContextService (orchestration/service.ts)
                                      │  contract: MemoryManagerContract
                                      ▼
                              MemoryManagerContractAdapter
                                      │  reuses real AG-002 services
                                      ├─ MemoryManager(retrieveMemory/createMemory/…)
                                      ├─ RetrievalServiceImpl.retrieve  (bounded, once)
                                      ├─ ContextIntegrationService.integrate (bounded)
                                      └─ MemoryConsolidationService.consolidate
```

- **AG-001 never touches repository/storage internals.** It depends only on the orchestration service and the `MemoryManagerContract` interface (via the adapter). AG-001 Sprint 1–9 were not modified; all adaptation lives on the AG-002 side.
- **Run the real pipeline once.** `fetchMemoryContext` calls the real retrieval step once (bounded by `MEMORY_ORCHESTRATOR_RETRIEVAL_TIMEOUT_MS`) and the real context assembly once (bounded by `MEMORY_ORCHESTRATOR_CONTEXT_TIMEOUT_MS`), reusing AG-002's own ranking/authorization/scoping/redaction.
- **Fail-closed.** A missing/empty actor namespace allow-list or a malformed actor yields `MemoryContextStatus.SecurityDenied`. An unhealthy contract yields `Unavailable`. A cancelled request short-circuits to `Unavailable` without invoking retrieval. Disabled config yields `Disabled`.
- **Correlation preserved.** `requestId`, `executionId`, `correlationId`, and `traceId` pass through verbatim into the result and the emitted audit event.

## Status Mapping

| Stored cause                                  | `MemoryContextStatus` |
| --------------------------------------------- | --------------------- |
| Integration flag off                          | `Disabled`            |
| Malformed / empty actor scope                 | `SecurityDenied`      |
| Contract unhealthy / non-operational          | `Unavailable`         |
| Retrieval/context step hit its bounded budget | `Timeout`             |
| Authorization denial during a step            | `SecurityDenied`      |
| Invalid response shape                        | `InvalidResponse`     |
| Retrieval+assembly returned no records        | `Empty`               |
| Records produced and assembled                | `Available`           |

`toStatus` inspects the `MemoryIntegrationError.category` first (bounded execution + typed failures), then falls back to the safe string signature — never leaking internal details.

## Security & Observability

- **Aggregate-only metrics.** `InMemoryOrchestrationMetrics` (and `StubMetricSink` for tests) count retrieval starts/successes/failures, authorization denials, context records supplied, truncations, and per-status counts. No memory contents, tokens, passwords, or keys are ever recorded.
- **Truthful health/capabilities.** A capability is only reported available when its dependency is present and the feature flag is on; the integration never claims a capability it does not implement.
- **Bounded execution.** `withTimeout` enforces a real wall-clock budget and only ever shortens the effective budget, so memory can never block the orchestrator indefinitely.
- **Unsupported restore** (no `MEMORY_RESTORED` lifecycle op) fails closed in the adapter with `MemoryUnsupportedOperationError` (deferred).

## Config Constants

- `DEFAULT_MEMORY_ORCHESTRATOR_INTEGRATION_ENABLED = false`
- `DEFAULT_MEMORY_ORCHESTRATOR_RETRIEVAL_TIMEOUT_MS = 500`
- `DEFAULT_MEMORY_ORCHESTRATOR_CONTEXT_TIMEOUT_MS = 250`
- `DEFAULT_MEMORY_ORCHESTRATOR_WRITE_BACK = 'NONE'`

## Backward Compatibility

- Additive only: new `orchestration/` module, new additive config keys, and an additive `export *` from the AG-002 index. No existing AG-002 service, contract, or emit site changed.
- AG-002 Sprint 1–9 files (`retrieval/`, `services/`, `repositories/`, `storage/`, `security/`, `events/`, `config/`) are untouched by this integration; the adapter only references their real public contracts.
- All baseline tests pass unchanged; the 11 new Sprint 8 tests are isolated to `orchestration-memory.test.ts`.

## Gates

- `npx vitest run` → **1059 passing** (85 files; 1048 baseline + 11 new).
- `npx tsc --noEmit` → 18 pre-existing errors only (`retrieval/scorer.ts` + `retrieval.service.test.ts`), none from Sprint 8.
- `npx eslint .` → 27 pre-existing errors only, all Sprint 8 files lint-clean.
- `tsc -p tsconfig.build.json` → clean build.
