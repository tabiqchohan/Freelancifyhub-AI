# AG-001 ↔ AG-002 — Sprint 14 (Production Runtime, Real Agent Execution & Runtime Wiring v1)

## 1. Objective

Deliver a **real production runtime** for the FreelancifyHub AI orchestrator by
resolving the five Sprint-14 blockers:

1. **No production composition root** — added a single authoritative
   `createProductionComposition` that wires the entire dependency graph.
2. **AG-001 ↔ AG-002 not wired as a real runtime dependency graph** — the
   composition root now constructs real AG-002 services (memory manager,
   retrieval, context integration, consolidation, authorization) behind a real
   AG-001 `MemoryContextProvider` used by a real executor.
3. **ExecutionEngine has no real production AgentExecutor path** — added
   `ProductionAgentExecutor` implementing the AG-001 `AgentExecutor` contract
   against a real `AgentRegistry`.
4. **Runtime events not fully emitted from actual operations** — every real
   production execution emits `RuntimeAgentEvent`s that are bridged into AG-002's
   canonical event log (in-memory, plus Postgres mirror in durable mode).
5. **No end-to-end request → orchestrator → agent → memory → response path** —
   a production HTTP runtime routes a request through the orchestrator to a real
   registered agent (`AG-101`) with provisioned AG-002 memory.

The sprint **reuses** existing AG-001/AG-002 abstractions and does **not**
redesign them, does **not** start AG-003/AG-004, and does **not** introduce fake
production implementations.

## 2. Scope

- **In scope:** composition root; real AgentRegistry (Phase 2); production
  AgentExecutor (Phase 3); first real runtime agent registered through the
  normal registry under the `AG-101` slot (Phase 4); AG-001↔AG-002 memory wiring
  reusing the existing `MemoryContextProviderAdapter` (Phase 5); runtime events
  through the existing AG-002 event infrastructure (Phase 6); runtime API keeping
  `/healthz` (Phase 7); health/readiness without secrets or DB URL exposure
  (Phase 8); E2E-1..E2E-12 (Phase 9); hardening audit (Phase 10); docs (Phase 11).
- **Out of scope:** AG-003, AG-004, LLM integration, vector search, runtime cache
  layer, redesign of AG-001 `OrchestrationRequest`, external integrations.

## 3. Composition root

`src/app/composition-root.ts` exposes `createProductionComposition({ env?, logger? })`
returning a `ProductionComposition`:

- **Environment:** `src/app/env.ts` (`parseCompiledEnv`) resolves base `Env` +
  AG-002 `MemoryConfig` from the same process environment, fail-closed on invalid
  values. Secrets are consumed once and never logged.
- **Storage:** in-memory (`InMemoryMemoryRepository` + `InMemoryStorageAdapter`)
  by default, or durable via `createPostgresAdapter` + `PostgresMemoryRepository`
  when `MEMORY_STORAGE_BACKEND=durable`. Durable without `MEMORY_DATABASE_URL`, or
  an unsupported backend, throws a `DiagnosticError` (fail-closed; no silent
  in-memory fallback).
- **AG-002 services:** `MatrixMemoryAccessPolicy`, `DefaultMemoryLifecycle`,
  `InMemoryMemoryRetrievalEngine`, `createAuthorizationService`, then
  `createMemoryManagerService`, `createRetrievalService`,
  `createContextIntegrationService`, `createMemoryConsolidationService`, all behind
  `MemoryManagerContractAdapter`. The contract is exposed to AG-001 through
  `createMemoryContextProvider({ contract })`.
- **AG-001 wiring:** `AgentRegistry` (with default `AG-101` runtime agent),
  `ProductionAgentExecutor`, `ProductionExecutorRegistry`, `ExecutionEngine`,
  `RoutingEngine`, `ExecutionPlanBuilder`, `RuleBasedIntentClassifier`,
  `ContextBuilder`, `SharedAggregationService`, `InMemoryOrchestratorEventEmitter`,
  `MasterOrchestratorService`.
- **Errors:** `src/app/errors.ts` — `DiagnosticError` with a typed `code` and
  `details`, never carrying secrets.

## 4. Runtime agent layer (Phases 2–4)

New `src/agents/runtime/`:

- `types.ts` — `RuntimeAgent`, `CancellationSignal`, `RuntimeAgentExecutionContext`,
  `RuntimeAgentExecutionResult`, `RuntimeAgentEvent`, `RuntimeAgentEventType`,
  `AgentAvailability`.
- `errors.ts` — `RuntimeAgentError`, `AgentRegistryError`,
  `RUNTIME_AGENT_ERROR_CODES` (`DUPLICATE_AGENT_ID`, `AGENT_NOT_FOUND`,
  `AGENT_UNAVAILABLE`, `AGENT_EXECUTION_INVALID_INPUT`, `AGENT_MALFORMED_RESULT`).
- `registry.ts` — `AgentRegistry` (register/has/get/unregister/isAvailable/list/
  configurationOf/capabilitiesOf/size). Duplicate ids throw fail-closed; retired
  agents are unavailable.
- `runtime-agent.ts` — `createRuntimeAgent` produces the first real runtime agent
  under **`AG-101`** with capabilities `project.create/edit/delete/view`, status
  `InDevelopment`, category `Client`. Its deterministic handler reads
  `request.input`/`input`, cooperates with the cancellation signal, and supports
  the `runtime.delayMs` / `runtime.fail` test knobs (retryable:false).
- `executor.ts` — `ProductionAgentExecutor` implements the AG-001 `AgentExecutor`
  contract: resolve from the registry (`AGENT_NOT_FOUND`/`AGENT_UNAVAILABLE`),
  provision memory (degrade to empty context with a warning on retrieval failure),
  guard against cancellation/timeout with a race, and emit runtime events.
- `index.ts` barrel.

## 5. Memory wiring (Phase 5)

Reuses the existing `createMemoryContextProvider` + `MemoryContextProviderAdapter`
without redesigning AG-001's `OrchestrationRequest`:

- `src/app/request-actors.ts` — `RequestActorRegistry` keyed by `requestId`
  (actor group + authorized namespaces + security clearance).
- `src/app/memory-context-builder.ts` — `MemoryAwareContextInputBuilder` recovers
  the `requestId` from `exec_<requestId>` via `derivation()` and resolves a
  `MemoryContextLoadInput` from the actor binding. Missing bindings or empty
  namespaces fail closed (no memory load). The executor provisions memory through
  `MemoryContextProvider`; retrieval failures degrade to empty context and are
  logged, never silently swallowed.

## 6. Runtime event bridge (Phase 6)

`src/app/runtime-event-bridge.ts` — the **single** event infrastructure is AG-002's.
Every `RuntimeAgentEvent` (started/completed/failed/retrieval) is mapped to an
AG-002 `MemoryEvent` and appended to `InMemoryEventLog` (the canonical audit log);
in durable mode the same event is mirrored through `PostgresEventSink`. No second
event system is introduced; authorization/security events continue to flow through
AG-002's own emitter.

## 7. Runtime entry + health (Phases 7–8)

`src/app/runtime.ts` — `ProductionRuntime` is a minimal Node HTTP server over the
composition:

- **`GET /healthz`** (and **`/health`**) — liveness/readiness; returns `ok`/`degraded`
  with uptime and a storage probe. Never includes secrets or the DB URL
  (`defaultHealth`).
- **`POST /runtime/request`** — accepts `{ text, role?, requestId?, traceId?, actor? }`,
  binds the request's memory actor via `RequestActorRegistry`, runs the real
  orchestrator, and returns the full `OrchestratorResponse`. 1 MB body cap; invalid
  JSON / empty text fail closed with 400.
- Graceful `shutdown()` closes the composition storage handles.

`src/index.ts` boots the composition + runtime, keeps `/healthz`, and shuts down
gracefully on SIGTERM/SIGINT (exit 1 on `DiagnosticError`).

## 8. E2E coverage (Phase 9)

`tests/integration/runtime/e2e.test.ts` drives the full HTTP + composition stack:

- E2E-1 happy path (request → orchestrator → AG-101 → memory → SUCCESS)
- E2E-2 liveness without leaking secrets
- E2E-3 unknown request fails closed
- E2E-5 runtime events in the canonical AG-002 log
- E2E-6 bound request actor provisions authorized namespaces
- E2E-9 concurrent request isolation
- E2E-10 deterministic responses
- E2E-12 graceful shutdown closes storage

`tests/integration/runtime/e2e.durable.integration.test.ts` is **Postgres-gated**
(`describe.skip` without `MEMORY_DATABASE_URL`): boots a durable composition,
serves a request, and mirrors runtime events into the durable event log.

## 9. Hardening audit (Phase 10)

The production path (`src/app/*`, `src/index.ts`, `src/agents/runtime/*`) imports
**no** test doubles. `FakeAgentExecutor`, `StaticExecutorRegistry`, and
`StubMemoryManagerContract` remain confined to the AG-001/AG-002 test
infrastructure (`execution/executors`, `orchestration/test-doubles.ts`) and are
absent from the composition root, runtime, and executor.

## 10. Unit tests

New `tests/unit/`:

- `agents/runtime/{registry,runtime-agent,executor}.test.ts` — registry semantics,
  agent determinism, executor resolve/availability/timeout/cancel/events/memory.
- `app/{composition-root,memory-context-builder,runtime-event-bridge,runtime,errors}.test.ts`
  — composition assembly + fail-closed, memory builder derivation + fail-closed,
  event bridge mapping, HTTP surface + health, typed errors.

## 11. Test results

| Gate             | Result                                                               |
| ---------------- | -------------------------------------------------------------------- |
| Runtime unit     | registry 6, runtime-agent 6, executor 10                             |
| App unit         | composition 4, memory-builder 6, event-bridge 5, runtime 8, errors 5 |
| E2E (in-memory)  | 8 passed                                                             |
| E2E (durable PG) | 2 passed (Postgres-gated; run against Neon)                          |
| `tsc --noEmit`   | Clean                                                                |
| Production path  | No test doubles imported (audit)                                     |

## 12. Deferred work

AG-003/AG-004, LLM integration, vector search, the runtime cache performance
layer, connection-pool telemetry/retries, and background consolidation over the
durable store remain explicitly deferred.

Changes are **uncommitted** by design (Sprint 14 spec: commit/push only when
asked).
