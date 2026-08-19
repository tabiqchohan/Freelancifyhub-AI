# AG-001 Master Orchestrator — Integration Sprint v1

Scope: `prompts/prompts19`. Delivers the real, interface-driven
`MasterOrchestratorService` that coordinates the existing Sprint 1–8 engines
end-to-end via dependency injection. No Sprint 1–8 engine was rewritten; the
architecture was not redesigned; no external integrations were added.

---

## 1. Purpose

Provide the single coordinator that takes an orchestration request and drives
the deterministic pipeline **validation → intent → context → routing →
planning → execution → aggregation → response**, wiring the existing engines
together while keeping each engine owner of its own domain. The service is a
coordinator only: it validates stage transitions, propagates correlation
context, handles the lifecycle, and assembles the final aggregated response.

---

## 2. Architecture

```
src/agents/ag-001-master-orchestrator/orchestrator/
├── index.ts          # public barrel (selective exports)
├── README.md         # module overview
├── types/            # OrchestratorStage, OrchestrationRequest, OrchestratorResponse, ...
├── interfaces/       # contracts: IntentClassifier, ContextBuilderContract,
│                     #   RoutingEngineContract, ExecutionPlanBuilderContract,
│                     #   CancellableExecutionEngine, AggregationServiceContract,
│                     #   MasterOrchestratorServiceContract
├── config/           # re-exports OrchestratorConfig (no duplication)
├── errors/           # OrchestrationError + toOrchestrationError
├── validators/       # validateOrchestrationRequest, normalizeOrchestrationRequest
├── builders/         # buildOrchestratorResponse
└── services/         # events.ts, master-orchestrator.service.ts
```

The service holds **no algorithm implementations**. Every domain concern is
delegated to an injected engine that already owns it (Sprints 1–8). The
orchestrator is transport-independent and deterministic: same input ⇒ same
response.

### Stage model (`OrchestratorStage`)

`VALIDATION → INTENT_DETECTION → CONTEXT_BUILDING → ROUTING → PLANNING →
EXECUTION → AGGREGATION → RESPONSE`.

---

## 3. Lifecycle

`MasterOrchestratorService.execute(input)`:

1. **Validation** — normalize the request (fills `requestId`/`traceId` when
   absent, never mutates the caller object), build the `AgentRequest` context.
2. **Intent** — `intentClassifier.classify(text, { role, requestId })`.
3. **Context** — `contextBuilder.build({ requestId, traceId, items, budget })`.
4. **Routing** — `routingEngine.route({ requestId, traceId, request, intent,
context, role, constraints })`.
   - `Escalated` ⇒ **fail-closed**: returns a `FAILED` response at
     `ROUTING` stage carrying the escalation, no plan/execution/aggregation.
5. **Planning** — `planBuilder.build(...)` then `validateExecutionPlan(plan)`.
6. **Pre-execution cancellation check** — a request already cancelled returns a
   `CANCELLED` response without touching the executor.
7. **Execution** — `executionEngine.execute({ executionId: 'exec_' + requestId,
plan, requestId, traceId, inputs })`. The execution id is derived
   deterministically so correlation stays stable.
8. **Aggregation** — `aggregationService.aggregate({ executionId, plan,
results: [execution], intent, route, context })`.
9. **Response** — `buildOrchestratorResponse`. Status comes from
   `aggregated.status` so **terminal execution states are never overwritten**
   (SUCCESS/FAILED/CANCELLED/TIMED_OUT are preserved exactly).

---

## 4. Interfaces

All contracts live in `orchestrator/interfaces/index.ts`:

- `IntentClassifier` — `classify(text, options): IntentResult` (Sprint 2).
- `ContextBuilderContract` — method-only `build(...)` surface so the real
  `ContextBuilder` (which has no `name`/`version`) satisfies it.
- `RoutingEngineContract` — `route(...): RouteDecision` (Sprint 4).
- `ExecutionPlanBuilderContract` — `build(...): ExecutionPlan` (Sprint 5).
- `CancellableExecutionEngine` — extends the execution engine contract with
  `cancel(executionId, reason?)` (Sprint 6 + cancellation).
- `AggregationServiceContract` — method-only `aggregate(...)` surface for the
  real `SharedAggregationService` (Sprint 8).
- `MasterOrchestratorServiceContract` — `execute(...)`, `cancel(...)`, stable
  `name`/`version`.

Method-only contracts are used wherever the real engine exposes a subset of the
stub's surface, so tests can inject deterministic doubles without lying about
interfaces.

---

## 5. Dependency Injection

`MasterOrchestratorService` receives all six engines in its constructor
(`MasterOrchestratorServiceDependencies`). It **never constructs engines
internally**.

- Missing dependency ⇒ `ConfigurationError` at construction time
  (`assertDependencies`), listing the missing keys — fail-fast, no partial state.
- `createMasterOrchestratorService()` is the **composition root** that wires the
  real engines (`RuleBasedIntentClassifier`, `ContextBuilder`, `RoutingEngine`,
  `ExecutionPlanBuilder`, `ExecutionEngine`, `SharedAggregationService`).
  Every dependency is overridable via partial options, so tests and future
  runtimes substitute doubles freely.
- Future managers (Memory/Knowledge/Tool) remain **optional/abstract**: they
  are not implemented and nothing fakes a production implementation. The
  service signature can later accept their interfaces without structural change.

---

## 6. Error Handling

- `toOrchestrationError(stage, error, correlation)` wraps any engine failure
  into a typed `OrchestrationError`:
  - hierarchy errors (`OrchestratorError` family) keep their **`code` and
    `retryable`** flags (e.g. `ROUTING_VALIDATION_ERROR`, `TIMEOUT_ERROR`);
  - unknown thrown values collapse to the safe generic `STAGE_ERROR`
    (`retryable: false`); message text is derived from `Error.message`.
- The wrapping error carries the failing **stage** plus `requestId`/`traceId`.
- `fail(...)` emits `ORCHESTRATION_FAILED`, logs, and **rethrows** — the
  caller sees a typed error, not a swallowed failure.
- Escalation is handled as a **fail-closed response** (status `FAILED`,
  stage `ROUTING`), not a thrown error.

---

## 7. Cancellation

`cancel(requestId, reason = 'cancelled by caller')`:

- Idempotent: marks the request cancelled (map), propagates to
  `executionEngine.cancel(executionId, reason)` when the execution is active,
  and always emits a correlated `ORCHESTRATION_CANCELLED` event.
- A request cancelled **before execution** returns `CANCELLED` with
  `stage: EXECUTION`, no execution, no aggregation, zero executor calls.
- A request cancelled **during execution** propagates through the engine's
  cancellation path and returns `CANCELLED` with `execution.state = CANCELLED`.
- Cancellation **after completion** does not corrupt the terminal state
  (the response is already committed as SUCCESS).

---

## 8. Timeout

- The orchestrator itself adds no timeout logic; it delegates to the execution
  engine's authoritative overall-deadline handling.
- A plan budget (`plan.policy.maxTotalExecutionTimeMs`) is honoured: when the
  deadline expires, the execution settles `TIMED_OUT` and the aggregated
  response reports `TIMED_OUT` (never a post-deadline `COMPLETED`).
- Verified end-to-end: a single-mode plan with a 60 ms budget and a slow
  executor returns `status: TIMED_OUT`, `execution.state: TIMED_OUT`,
  `aggregated.status: TIMED_OUT`.

---

## 9. Observability

- Structured `pino` logs per lifecycle event (orchestrator, routing, planning,
  execution, aggregation) with `requestId`/`traceId`/stage/`code`/`retryable`.
- The orchestrator logs a single completion record with intent, route status,
  plan id, execution state, response status and duration.
- Stage failures log the wrapped error's `code`/`retryable` (no payloads, no
  secrets).

---

## 10. Events

`OrchestratorEventType` (11 types) emitted in deterministic order:

`ORCHESTRATION_STARTED → INTENT_DETECTED → CONTEXT_BUILT → ROUTING_COMPLETED →
PLAN_CREATED → EXECUTION_STARTED → EXECUTION_COMPLETED →
AGGREGATION_COMPLETED → ORCHESTRATION_COMPLETED` (plus `ORCHESTRATION_FAILED`
and `ORCHESTRATION_CANCELLED`).

`InMemoryOrchestratorEventEmitter` provides `emit/on/list/clear` and is the
default sink; any `OrchestratorEventEmitter` can be injected. Every event is
correlated with `requestId`/`traceId`; stage-relevant fields (`executionId`,
`planId`, `intentId`, `status`, `errorCode`, `metadata`) are attached.

---

## 11. Security

- **Fail-closed routing**: unknown/ambiguous/permission-denied routes never
  reach planning or execution; the response is `FAILED` at the `ROUTING` stage.
- **Sensitive output sanitization**: step outputs/metadata are sanitized by the
  canonical sanitizer at the aggregation trust boundary (Sprint 8). Verified
  end-to-end: `apiKey`, `password`, and their values never appear in the
  serialized `OrchestratorResponse`.
- **No secrets in logs/events**: logs carry ids/status/codes only; events carry
  structured metadata, never payload contents.
- **Typed errors**: no internal stack internals leak beyond the original
  error's own message/details.

---

## 12. Test Coverage

New tests live in
`tests/unit/agents/ag-001-master-orchestrator/orchestrator/`:

| File                  | Covers                                                                                                                                                                                                                                                                                                                                                               |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fixtures.ts`         | deterministic stubs (classifier/routing/plan/execution/aggregation), `createTestService` wiring real engines with fast execution config, `planForMode`, `planWithTimeout`                                                                                                                                                                                            |
| `validators.test.ts`  | validation + normalization (ids filled, no mutation, passthrough)                                                                                                                                                                                                                                                                                                    |
| `errors.test.ts`      | `OrchestrationError` + `toOrchestrationError` (code/retryable/stage/correlation preservation, generic collapse)                                                                                                                                                                                                                                                      |
| `events.test.ts`      | emitter recording, handlers, unsubscribe, clear                                                                                                                                                                                                                                                                                                                      |
| `service.test.ts`     | construction/DI fail-fast, lifecycle ordering, error propagation per stage, cancellation (before/during/idempotent), timeout, terminal-state preservation                                                                                                                                                                                                            |
| `integration.test.ts` | all 20 scenarios: single-agent E2E, unknown/ambiguous intent, routing/planning/execution/aggregation failure, fallback, timeout, cancellation (parallel + after completion), parallel/conditional/hybrid execution, sanitization, constraints, draft/disabled filtering, correlation propagation, terminal preservation, concurrent requests, deterministic response |

All test doubles are deterministic; nothing calls real LLMs, OpenClaw,
FreelancifyHub, Stripe, or a database.

---

## 13. Gates

| Gate                            | Result                               |
| ------------------------------- | ------------------------------------ |
| Tests (orchestrator suite)      | 54 passing (5 files)                 |
| Typecheck                       | clean (`tsc --noEmit`)               |
| Lint (orchestrator src + tests) | clean (`eslint`)                     |
| Build                           | clean (`tsc -p tsconfig.build.json`) |

---

## 14. Remaining Limitations

- Single request lifecycle: only one execution per request is tracked; the
  `ExecutionEngine` idempotency guard covers duplicate concurrent execution ids.
- No memory/knowledge/tool managers yet (future AG-002/003/004 concerns).
- Transport layer (HTTP/OpenClaw gateway/API) intentionally absent; the service
  is callable in-process and will be adapted by future runtimes.

---

## 15. Explicit Confirmations

- No AG-002, AG-003 or AG-004 integration was implemented.
- No LLM APIs, OpenClaw Gateway, FreelancifyHub APIs, Stripe, database or
  production credentials were added.
- No Sprint 1–8 engine was rewritten and no architecture was redesigned.
- **No commit/push was performed.**
