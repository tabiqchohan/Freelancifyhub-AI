# AG-001 Master Orchestrator — Sprints 1–7 Architecture & Implementation Audit v1

|                           |                                                                                                    |
| ------------------------- | -------------------------------------------------------------------------------------------------- |
| **Component**             | AG-001 Master Orchestrator                                                                         |
| **Sprints audited**       | 1 (Foundation), 2 (Intent), 3 (Context), 4 (Routing), 5 (Planning), 6 (Execution), 7 (Aggregation) |
| **Audit type**            | AUDIT ONLY — no source code was modified                                                           |
| **Audit date**            | 2026-08-14                                                                                         |
| **Implementation commit** | `99d6d00`                                                                                          |
| **Auditor**               | Senior AI Systems / TS / Distributed Systems / OpenClaw / Security / QA Architect                  |

---

## 1. Executive Summary

AG-001 Master Orchestrator is implemented as a **deterministic, layered, TypeScript module tree**
(117 source files, ~373 KB) with unusually strong unit-test coverage (489 tests / 50 files).
The seven sprints form a coherent pipeline:

```
Request → Intent → Context → Routing → Planning → Execution → Aggregation → Final Response
```

The implementation is **structurally sound and architecturally aligned** with the source-of-truth
chain (Blueprint → PRD → Catalog → Master Orchestrator Spec → ADK). No architectural contradiction,
no circular dependency, and no spec violation that would require re-architecture were found.

However, the audit confirmed **two CRITICAL defects** that must be resolved before production:

1. **[C-1] Sensitive step `output` is NOT sanitized** — secrets embedded in an agent step's output
   propagate verbatim into the public `AggregatedResponse.outputs` artifact.
2. **[C-2] The overall execution-timeout race is unreliable under load** — under event-loop
   starvation a `setTimeout` can fire out of expiry order, so an execution that exceeds its
   deadline can be reported as `COMPLETED` (this is the root cause of the intermittent
   `execution/timeout.test.ts` flake, reproduced 3× in the real vitest suite and 1.5% in a
   400-run direct-engine probe).

A further cluster of HIGH findings concern **dead or unenforced configuration surface**
(six intent/routing/execution flags plus cost/min-confidence/dependency constraints are
declared and validated but never consumed) and **cross-sprint semantic leaks** (Draft-status
agents can be selected as primary and leak into multi-agent plans; declared agent dependency
graphs are dropped between routing and planning).

**Determination — Sprint 8 is NOT required as additional core implementation (Option B).**
AG-001 core is functionally complete across all seven sprints. The correct next step is a
**hardening/integration sprint** that fixes the two CRITICALs and the HIGH findings, closes the
dead-config surface, adds security/stress regression tests, and integrates the pipeline
end-to-end with a real `AgentExecutor` (the current executor is a test double).

| Metric                | Result                                                          |
| --------------------- | --------------------------------------------------------------- |
| Actual test count     | **489 passed / 489** (50 files)                                 |
| Flaky tests           | **1** (`execution/timeout.test.ts` — overall execution timeout) |
| Typecheck             | **PASS** (`tsc --noEmit`)                                       |
| Lint                  | **PASS** (`eslint .`)                                           |
| Build                 | **PASS** (`tsc -p tsconfig.build.json`)                         |
| Critical issues       | 2                                                               |
| High issues           | 7                                                               |
| Medium issues         | 14                                                              |
| Low issues            | 9                                                               |
| Info issues           | 10                                                              |
| AG-001 overall score  | **82 / 100**                                                    |
| Production readiness  | **64 / 100**                                                    |
| Integration readiness | **72 / 100**                                                    |
| Test readiness        | **85 / 100**                                                    |
| Security readiness    | **58 / 100**                                                    |

---

## 2. Scope

- **In-scope:** `src/agents/ag-001-master-orchestrator/` (all Sprint 1–7 modules) and
  `tests/unit/agents/ag-001-master-orchestrator/`.
- **Out-of-scope:** AG-002/003/004 (not implemented — interface boundaries only), OpenClaw gateway
  integration (architectural readiness only), external service integration.
- **Method:** source inspection, `git` history review, full test suite run, targeted stress probes,
  and parallel module-by-module audits. All claims verified against actual code with `file:line`.
- **Constraint honored:** no source files modified; only the audit report was created.

---

## 3. Source of Truth

Compared against:

1. `docs/freelancify-ai-blueprint-v1.0.md` (§9 Master Orchestrator)
2. `docs/product-requirements-v1.md` (BR-AI-1..5, BR-RATE-2, AC-08/24/25)
3. `docs/agent-catalog-v1.md` (§9 AG-001 entry)
4. `docs/master-orchestrator-specification-v1.md`
5. `docs/shared-memory-architecture-v1.md` (§8–9 memory coordination contracts)
6. `docs/tool-registry-architecture-v1.md` (§10 tool coordination contracts)
7. `docs/knowledge-base-architecture-v1.md` (§9 knowledge coordination contracts)
8. `docs/agent-development-kit-v1.md` (§3, §15 output contracts)
9. `docs/architecture-review-v1.md` (scorecard, D5 context-builder boundary note)
10. `prompts/README.md`, `docs/index.md`, `prompts/prompts11..prompts17`

Implementation source of truth: the actual source code (verified, not assumed).

---

## 4. Sprint Completeness Audit

| Sprint                  | Required                                                                                                                                                         | Implemented                                                                                                  | Missing                                                                                                                         | Extra                                                                                                                                                                                                             | Violations                                                                                                  | Status                 |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------- |
| **1 Foundation**        | Error hierarchy, config schema, validators, utils, schemas, interfaces, builders, DI services                                                                    | All present; root barrel + README                                                                            | `MasterOrchestratorService` orchestration entry point absent (only `SharedAggregationService` exists)                           | DI abstractions (interface-only)                                                                                                                                                                                  | None                                                                                                        | **COMPLETE_WITH_GAPS** |
| **2 Intent Detection**  | Registry, keyword/phrase matching, duplicate detection, unknown intent, confidence, ambiguity, multi-intent, extensibility, AI-ready abstraction                 | All present (24 intents, rule-based classifier behind `IntentClassifier` interface)                          | None functional; single-word saturation semantics weak                                                                          | `KEYWORD_GROUPS`/`INTENT_KEYWORDS` drift                                                                                                                                                                          | `SATURATION_UNITS=2` lets two weak single-word keywords saturate to 1.0; `INTENT_MULTI_INTENT_ENABLED` dead | **COMPLETE_WITH_GAPS** |
| **3 Context Builder**   | Sources, priority, token estimation, compression, dedup, normalization, budget, critical preservation, determinism, config                                       | All present (priority tiers, FNV-1a dedup, CRITICAL-never-drop, overflow fail/truncate)                      | `CONTEXT_MIN_TOKENS` never enforced; compression inert post-normalization                                                       | —                                                                                                                                                                                                                 | None                                                                                                        | **COMPLETE_WITH_GAPS** |
| **4 Agent Routing**     | Candidate selection, capability match, priority, availability, fallback, cost, confidence, multi-agent, disabled behavior, determinism                           | All present (34-agent catalog, deterministic scorer, escalation, fallback)                                   | Cost (`maxRoutingCost`/`ROUTING_MAX_COST`), `minConfidence`, `requiredPermissions`, `allowedRoles` validated but never enforced | Dead `ROUTING_DEFAULT_STRATEGY`/`ROUTING_DEFAULT_EXECUTION_MODE`                                                                                                                                                  | Draft/Retired agents not pre-filtered → can be selected primary / leak into multi-agent plans               | **COMPLETE_WITH_GAPS** |
| **5 Execution Planner** | Single/seq/parallel/conditional/hybrid, dependency graph, topo sort, cycle detection, optimization, dangling/unreachable handling, constraints, failure policies | All present (Kahn topo-sort + `ExecutionCycleError`, `SafePlanOptimizer`, limits, mode gating)               | None                                                                                                                            | —                                                                                                                                                                                                                 | None                                                                                                        | **COMPLETE**           |
| **6 Execution Engine**  | AgentExecutor abstraction, lifecycle, state machine, all modes, retry, timeout, cancellation, failure policy, concurrency, idempotency, events, metrics, cleanup | All present (state machine w/ transitions table, retry w/ backoff, cancellation controller, events, metrics) | True concurrency bound; executor abort on timeout/cancel; hybrid parallelism                                                    | Dead flags (`EXECUTION_DEFAULT_TIMEOUT_MS`, `EXECUTION_DEFAULT_RETRY_ATTEMPTS`, `EXECUTION_CANCELLATION_ENABLED`, `EXECUTION_IDEMPOTENCY_ENABLED`, `EXECUTION_PARALLEL_ENABLED`, `EXECUTION_CONDITIONAL_ENABLED`) | `EXECUTION_MAX_CONCURRENT_STEPS` not enforced (metric-only); **timeout race unreliable under load**         | **COMPLETE_WITH_GAPS** |
| **7 Aggregation**       | validate → normalize → order → dedupe → status → statistics → retries → format; security sanitization                                                            | All present (deterministic orderer, strict/loose dedupe, status dominance, statistics, truncation, warnings) | Documented `group` step never executed (dead `ResultGrouper`/`AggregationWorkspace`)                                            | —                                                                                                                                                                                                                 | **Step `output` not sanitized (CRITICAL)**; `sanitizeRecord` key-list gaps / over-match                     | **COMPLETE_WITH_GAPS** |

---

## 5. Blueprint Consistency

The implementation honors the Blueprint §9 model: single entry point, policy enforcement,
fan-out/fan-in planning, audit emission, fail-closed routing, default-deny. No contradiction with
OpenClaw multi-agent architecture or the memory/knowledge/tool boundaries (AG-001 owns
coordination only; AG-002/003/004 are interface contracts, not implemented).

| Source                                                   | Implementation                                                        | Expected                                                         | Severity | Recommendation                             |
| -------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------- | -------- | ------------------------------------------ |
| Blueprint §9: "only component that talks to team agents" | `AgentExecutor`/`ExecutorRegistry` abstractions (execution module)    | Abstraction present; executor is `FakeAgentExecutor` test double | LOW      | Wire a real executor in integration sprint |
| Blueprint §9: fail-closed on unknown intent              | `UNKNOWN` fallback at 0.1 confidence; escalation                      | Matches                                                          | —        | None                                       |
| Blueprint §23: pino JSON logging w/ trace/event          | pino child logger, no payload logging                                 | Matches                                                          | —        | None                                       |
| Blueprint §15/16/17 boundaries                           | Providers are interface-only; no memory/knowledge/tool implementation | Matches (no leakage)                                             | —        | None                                       |

**No blueprint contradiction identified.**

---

## 6. Master Orchestrator Specification Compliance

| Responsibility             | Spec      | Implementation                                 | Gap                                              | Severity |
| -------------------------- | --------- | ---------------------------------------------- | ------------------------------------------------ | -------- |
| 1 Intent detection         | §5        | Rule-based classifier + AI-ready interface     | Single-word saturation defect (F-INT-1)          | HIGH     |
| 2 Context construction     | §7        | Priority/budget/dedup pipeline                 | `minTokens` unenforced; silent truncation        | MEDIUM   |
| 3 Agent routing            | §8        | Deterministic scorer + fallback/escalation     | Draft agents selectable; constraints unenforced  | HIGH     |
| 4 Execution planning       | §11       | 5 strategies + topo-sort + optimizer           | Agent dependencies dropped                       | MEDIUM   |
| 5 Execution                | §12       | State machine + 5 strategies                   | No concurrency bound; hybrid sequential          | HIGH     |
| 6 Result aggregation       | §13       | Full pipeline                                  | `group` step dead; **output unsanitized**        | CRITICAL |
| 7 Error handling           | §16       | Typed hierarchy w/ codes + retryable           | Loose error-attr loss in aggregation             | LOW      |
| 8 Retry                    | §13/§16   | Backoff + budget; retry history in aggregation | `EXECUTION_DEFAULT_RETRY_ATTEMPTS` dead          | MEDIUM   |
| 9 Timeout                  | §12       | Overall + step deadlines                       | **Race unreliable under load; timer leak**       | CRITICAL |
| 10 Cancellation            | §12       | Controller + race arm                          | Executor never aborted                           | MEDIUM   |
| 11 Security                | §14/§17   | Sanitization, fail-closed, audit logging       | **Output leak**; key-list gaps                   | CRITICAL |
| 12 Observability           | §19       | Events, metrics, JSON logs                     | `EXECUTION_*_ENABLED` event flags dead           | MEDIUM   |
| 13 Cost management         | §8        | `maxRoutingCost`/`ROUTING_MAX_COST` declared   | **Never enforced**                               | HIGH     |
| 14 State management        | §12       | Per-execution state machine + store            | All-cancelled run → `Completed` fallback         | LOW      |
| 15 Configuration           | §22       | Zod schemas + eager singletons                 | 10+ dead keys across modules                     | HIGH     |
| 16 API contracts           | §15       | Schema-first validators on every boundary      | `MasterOrchestratorService` entry missing        | LOW      |
| 17 Events                  | §19       | 13 event types, ordered emitter                | Feature flags dead; event gaps in some paths     | MEDIUM   |
| 18 Escalation              | §4/§8     | Escalation statuses + reasons                  | Escalated decision retains stale `selectedAgent` | HIGH     |
| 19 Rate limits             | BR-RATE-2 | Declared in catalog (100 req/min)              | Not enforced in AG-001 (gateway concern)         | INFO     |
| 20 Performance constraints | §21       | Limits enforced at planning; concurrency not   | `EXECUTION_MAX_CONCURRENT_STEPS` metric-only     | HIGH     |

---

## 7. Agent Catalog Consistency (AG-001)

| Catalog field                                                              | Verification                                                                                                                |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Responsibilities (intent, policy, plan composition, error handling, audit) | Implemented across Sprints 2–7                                                                                              |
| Non-responsibilities                                                       | No AG-002/003/004 leakage (see §24)                                                                                         |
| Interfaces / dependencies / permissions                                    | Interface + permission model present; dependency graph lost at routing→planning (F-RTE-4)                                   |
| Context requirements (trace ID, identity, namespace, active plan)          | Present in `RequestContext`; namespace scope not yet enforced (platform concern)                                            |
| Memory usage                                                               | Only interface contracts; no AG-002 implementation (correct — not AG-001's job)                                             |
| LLM requirements                                                           | No LLM dependency in deterministic core; AI-ready interfaces present                                                        |
| Failure handling (fail-closed, escalation)                                 | Present; escalated decision carries stale `selectedAgent` (F-RTE-1)                                                         |
| Retry policy (idempotent, max 3)                                           | `EXECUTION_MAX_RETRY_ATTEMPTS=5` default vs catalog "max 3" — **documented default differs**; idempotency flag dead (F4/F6) |
| Observability / security / privacy                                         | Logging minimal, no payloads; output sanitization gap (C-1)                                                                 |
| Rate limits / cost controls                                                | Not enforced (F-RTE-3, §6)                                                                                                  |
| KPIs / acceptance criteria                                                 | Fail-closed behavior present; routing accuracy/escalation-time KPIs not yet measurable (no real routing telemetry)          |

---

## 8. Sprint-by-Sprint Detail

### 8.1 Sprint 1 — Foundation

Present: `types/`, `errors/`, `config/`, `validators/`, `utils/`, `schemas/`, `interfaces/` (11 files),
`services/`, `builders/` (3 builders), root `index.ts`. Error hierarchy with codes + `retryable`
(`PipelineError`/`DependencyError`/`TimeoutError` retryable; `ValidationError`/`ConfigurationError` not).
Zod `OrchestratorConfigSchema` with env parsing and `ConfigurationError`. Deterministic builders that
self-validate on `build()`.

- **[I-1] `MasterOrchestratorService` does not exist** (grep = 0 matches). The orchestration entry
  point expected for the pipeline is absent; only `SharedAggregationService` exists (Sprint 7).
- DI abstractions (`ServiceKey`, `DependencyContainer`) are interface-only and **untested**.

### 8.2 Sprint 2 — Intent Detection

24-intent catalog, `KeywordMatcher` (token-set presence, phrase = whitespace keyword),
`RuleBasedIntentClassifier` behind the AI-replaceable `IntentClassifier` interface, registry-level
duplicate id/keyword rejection, UNKNOWN fallback, deterministic tie-breaks.

- **[H-1] Single-word keyword confidence defect** — `SATURATION_UNITS = 2`
  (`intent/classifiers/index.ts:20`), `confidence = min(1, matchedWeight / 2)` (:111),
  `qualifies()` requires `confidence >= max(intentThreshold, INTENT_LOW_THRESHOLD)` (:131-134).
  Two consequences: (a) **two single-word keywords of one intent saturate to 1.0** with default
  config (`"chat dm"` → SEND_MESSAGE 1.0; `"scam fraud"` → REPORT_SCAM 1.0); (b) a lone single
  word (0.5) qualifies as soon as `INTENT_LOW_THRESHOLD ≤ 0.5` — and the registry itself declares
  thresholds of 0.45 (`registry/index.ts:232,254`), showing the design intended such qualification.
  The no-single-word guarantee holds only by default-threshold accident, not by formula.
- **[H-2] `INTENT_MULTI_INTENT_ENABLED` is dead** (`config.ts:23` never read) — multi-intent output
  is unconditional.
- **[M-1] `INTENT_HIGH_THRESHOLD` is metadata-only** (no decision reads it).
- **[M-2] `INTENT_DEFAULT_STATUS` is dead** (registry hardcodes `Active`).
- **[L-1] `IntentRule.keywordWeight` is dead data** (matcher recomputes weights).
- **[L-2] No `HIGH > LOW` cross-field validation** in intent config (routing has `superRefine`).

### 8.3 Sprint 3 — Context Builder

Priority tiers (`CRITICAL..OPTIONAL`), FNV-1a content-identity dedup, character token estimation
(`ceil(len/4)`), `BudgetManager` (CRITICAL never dropped, `truncate`/`fail` overflow), deterministic
ordering, `ContextBuilder` orchestration. Provider interfaces for AG-002/003/004 are interface-only.

- **[M-3] `CONTEXT_MIN_TOKENS` never enforced** (`config/index.ts:37` parsed/validated/written into
  snapshot but `BudgetManager.apply` never reads it) — the documented "minimum budget must remain
  available" guarantee does not exist.
- **[M-4] `CONTEXT_COMPRESSION_ENABLED` is functionally inert** — `normalizeItem` already collapses
  whitespace (`normalizer.ts:8-10`), so `DeterministicCompressor` (identical transform) is a no-op
  for well-formed input.
- **[M-5] Silent truncation** — excluded items are counted in statistics but emit no warning unless
  utilization ≥ `CONTEXT_WARNING_THRESHOLD`; a build can silently lose context below the threshold.
- **[L-3] Dedup key drops `metadata`/`order`** — items differing only in those fields collapse.
- **[L-4] `snapshot.items` vs `snapshot.sections` ordering can diverge** (different comparators).

### 8.4 Sprint 4 — Routing

34-agent catalog, `DeterministicRouteScorer` (8 weighted factors summing to 1), direct vs
capability-match strategy, fallback + escalation, deterministic candidate sort, multi-agent
mode resolution (Single/Parallel/Hybrid).

- **[H-3] Draft-status agents can be selected as primary and escalated decisions retain a stale
  `selectedAgent`** — `buildCandidates` never applies `isRoutableStatus` (`engine.ts:223-255`);
  ~14 default-catalog agents are `Draft`, so intents like `OPTIMIZE_PROFILE`, `GENERATE_CONTRACT`,
  `OPEN_DISPUTE` always escalate, producing `status: escalated` **with** a `selectedAgent` pointing
  at the non-routable agent (`engine.ts:133,148-162`, `fallback/index.ts:72-79`).
- **[H-4] `ROUTING_DEFAULT_STRATEGY` / `ROUTING_DEFAULT_EXECUTION_MODE` are dead** (`config/index.ts:29-32`).
- **[H-5] Cost & confidence constraints validated but never enforced** — `maxRoutingCost`,
  `minConfidence` pass `validateConstraints` but appear nowhere in selection/scoring;
  `ROUTING_MAX_COST` feeds only the never-called `defaultConstraints`; `requiredPermissions` is
  dead; `allowedRoles` is a documented no-op (`matchers/index.ts:52-54`).
- **[M-6] Agent dependency graph lost between routing and planning** — `RouteCandidate.agent`
  carries `AgentDependency[]`, but the planner builds edges purely from execution mode and never
  reads `agent.dependencies` (`planning/strategies/index.ts:156,318`).
- **[M-7] Non-routable agents leak into multi-agent plans** (e.g., `ADMIN_ACTION` + multi-agent →
  Hybrid plan referencing Draft AG-503/504/505).
- **[L-5] Dead error classes + `RoutingStatus.Failed`** never produced.

### 8.5 Sprint 5 — Planning

Five strategies, Kahn topological sort with `ExecutionCycleError`, `SafePlanOptimizer`
(dedupe/prune/merge), `validatePlan`, limits (`PLANNING_MAX_STEPS/DEPTH/PARALLEL_BRANCHES`),
mode gating via `PLANNING_*_ENABLED`. Plans are consumed correctly by Sprint 6
(`plan.planId`, `step.agentId`, `step.timeoutMs`, `step.retry`, `failurePolicy`, `dependencies`).

- No correctness defect found in Sprint 5. **Status: COMPLETE.**

### 8.6 Sprint 6 — Execution

`ExecutionEngine` with `Promise.race([work, deadline, cancellation])`, `ExecutionStateManager`
(transition table), `ExecutionLifecycle` (per-step guards), retry w/ exponential backoff,
`CancellationController`, `InMemoryExecutionEventEmitter`, metrics. All five mode strategies.

- **[C-2] Overall-timeout race is unreliable under load** — `engine/index.ts:152-156`. Under
  event-loop starvation Node can fire a 20ms timer after a 40ms timer (empirically 5.6% in an
  isolated 1500-iteration probe; 1.5% COMPLETED in a 400-run direct-engine probe; reproduced 3× in
  the real vitest suite). When the executor wins the race, `settled='done'` and
  `computeFinalState` reports `Completed` even though the run exceeded its 20ms budget by ~2×.
  `computeFinalState` (:335-362) has no elapsed-vs-budget re-check.
- **[C-3] Per-execution timer leak** — `createDeadline` returns `{promise, clear}`
  (`timeout/index.ts:38-41`) but the engine never calls `deadline.clear()`
  (`engine/index.ts:148`); every `execute()` leaks a timer for up to `EXECUTION_MAX_TIMEOUT_MS`
  (default 120s). (`withTimeout`'s own timer IS cleared correctly in `.finally`.)
- **[H-6] `EXECUTION_MAX_CONCURRENT_STEPS` not enforced** — used only for the `parallelBranches`
  metric (`engine/index.ts:396,401`); `ParallelExecutionStrategy` fires all steps at once
  (`strategies/index.ts:101`).
- **[M-8] Six dead execution flags** — `EXECUTION_DEFAULT_TIMEOUT_MS`, `EXECUTION_DEFAULT_RETRY_ATTEMPTS`,
  `EXECUTION_CANCELLATION_ENABLED`, `EXECUTION_IDEMPOTENCY_ENABLED`, `EXECUTION_PARALLEL_ENABLED`,
  `EXECUTION_CONDITIONAL_ENABLED`, plus dead `isExecutionFeatureEnabled()` — none wired into behavior.
  (The flaky test itself sets `EXECUTION_DEFAULT_TIMEOUT_MS='10'` believing it matters.)
- **[M-9] Cancellation/timeout never aborts the underlying executor** — the executor promise is
  orphaned; `AgentExecutor.cancel` is never invoked anywhere.
- **[M-10] Hybrid mode executes fully sequentially** — `HybridExecutionStrategy` is identical to
  `SequentialExecutionStrategy`; the parallel middle wave never runs concurrently.
- **[L-6] Parallel strategy ignores dependencies**; **[L-7] all-cancelled run → `Completed` fallback**
  (`engine/index.ts:361`); **[L-8] `dependencyOrder` silently tolerates leftover cycles**.

### 8.7 Sprint 7 — Aggregation

Pipeline: `validate → normalize → order → dedupe → status → statistics → retries → format`.
Deterministic orderer (plan position → order → startedAt → stepId), strict/loose duplicate
semantics (`AGGREGATION_STRICT_VALIDATION`), status dominance (`Cancelled → TimedOut → Failed →
Partial → Completed`), statistics counters, metadata truncation, warning construction from safe
fields only, `SharedAggregationService` accepting `AggregationServiceOptions | AggregationConfig`
(discriminated by `AGGREGATION_`-prefixed keys). **99 tests.**

- **[C-1] Sensitive step `output` is NOT sanitized** — `normalizers/index.ts:137` copies
  `output: step.output` raw and `formatters/index.ts:79` forwards it into `AggregatedOutput.output`
  (`types/index.ts:95`). `sanitizeRecord` is applied ONLY to `metadata` (`normalizers/index.ts:144`).
  Any secret embedded in an agent step's output (`apiKey`, `token`, credentials) reaches the public
  response verbatim — contradicting `aggregation/README.md:144-146`. The only secret-leak test
  (`compatibility.test.ts:98-123`) injects into `metadata`, not `output`.
- **[H-7] `sanitizeRecord` key-list false negatives** — pattern (`utils/index.ts:7-8`) does not
  match `pwd` or `passphrase`. (The audited list — apiKey/token/secret/password/authorization/
  credentials — IS covered.)
- **[M-11] `sanitizeRecord` over-matches benign keys** — substring alternations `pan`/`pin`/`auth`
  strip `company`, `authorId`, `spin`, etc. from metadata (data loss, not a leak).
- **[M-12] Documented `group` step never executed** — `DefaultResultGrouper`/`ResultGrouper`/
  `AggregationWorkspace` are exported but unreferenced by `SharedAggregationService`.
- **[M-13] Custom injected normalizers silently lose retry history** — `collectRetries` guards on
  `instanceof ExecutionResultNormalizer` (`aggregators/index.ts:98-103`).
- **[M-14] `AGGREGATION_MAX_METADATA_SIZE` bounds metadata only** — `outputs`/`errors`/`warnings`
  are unbounded.
- **[L-9] `ExecutionError.details`/`cause` discarded** (safe-by-drop but loses diagnostics);
  **[L-10] `ResultGroup.Partial` unreachable**; **[L-11] validator key (`executionId:planId`) vs
  dedupe key (`executionId:stepId`) mismatch**.
- **[I-2] aggregation not re-exported from root barrel**; **[I-3] dead `AggregationPolicy`/
  `OutputAggregator`**; **[I-4] `StatusCalculator` signature mismatch**; **[I-5] `completedAt`
  timestamp is the documented determinism exception.**

---

## 9. Interface & Contract Audit

| Contract                                 | Location                              | Used By          | Issue                                                                      | Severity |
| ---------------------------------------- | ------------------------------------- | ---------------- | -------------------------------------------------------------------------- | -------- |
| `IntentClassifier`                       | intent/types.ts:147                   | classifier       | AI-replaceable; clean                                                      | —        |
| `IntentMatcher`                          | intent/types.ts:157                   | matcher          | Clean                                                                      | —        |
| `ContextProvider` family                 | context/interfaces/providers.ts       | —                | Interface-only (AG-002/003/004 seam)                                       | —        |
| `AgentExecutor` / `ExecutorRegistry`     | execution/interfaces/index.ts:12-27   | engine           | `cancel` never invoked                                                     | MEDIUM   |
| `AgentDependency`                        | interfaces/execution-context.ts:22    | routing→planning | **Semantics dropped** (edges not built)                                    | MEDIUM   |
| `RoutingConstraints`                     | routing/types/index.ts:141-146        | validators only  | `maxRoutingCost`/`minConfidence`/`requiredPermissions` never enforced      | HIGH     |
| `ResultGrouper` / `AggregationWorkspace` | aggregation/interfaces & types        | —                | Dead abstraction (group step unexecuted)                                   | MEDIUM   |
| `OutputAggregator` / `AggregationPolicy` | aggregation/interfaces & types        | —                | Dead public types                                                          | INFO     |
| `StatusCalculator`                       | aggregation/interfaces/index.ts:40-46 | service          | Signature mismatch (config param unused)                                   | INFO     |
| `SharedAggregationService`               | aggregation/aggregators/index.ts:37   | consumers        | Bare-config discriminator works; 0-key config misclassified (undocumented) | INFO     |

No duplicate interfaces, no incompatible types, no circular dependencies, no `any` misuse, no
unsafe casts, no mutable shared state found across module boundaries.

---

## 10. Dependency Graph Audit

The tree is strictly **layered** — no reverse dependencies, no domain→infrastructure inversion,
no test-only deps in production code, no cross-sprint cycles.

```
index.ts
  ├── types / errors / schemas / utils / validators / config   (foundation)
  ├── builders / services / interfaces                          (contracts)
  ├── intent ──► context ──► routing ──► planning ──► execution ──► aggregation
  └── (aggregation not re-exported from root — I-2)
```

Each engine module imports only the types/contracts of its upstream stage and its own config —
dependencies flow strictly forward (Intent → Context → Routing → Planning → Execution → Aggregation).

```mermaid
graph LR
  REQ[RequestContext] --> INT[Intent]
  INT --> CTX[Context]
  CTX --> RT[Routing]
  RT --> PL[Planning]
  PL --> EX[Execution]
  EX --> AG[Aggregation]
  AG --> FINAL[Final Response]
```

---

## 11. Execution Pipeline Audit

Trace of the actual code path:

1. `RequestContext` (Sprint 1) → `IntentResult` (Sprint 2, `classifiers/index.ts:35-90`)
2. → `ContextSnapshot` (Sprint 3, `builders/index.ts:36-114`)
3. → `RouteDecision` (Sprint 4, `engine.ts:54-213`)
4. → `ExecutionPlan` (Sprint 5, `builders/index.ts:49-121`)
5. → `ExecutionContext` + `ExecutionResult` (Sprint 6, `engine/index.ts:75-259`)
6. → `AggregatedResponse` (Sprint 7, `aggregators/index.ts:67-95`)

| Check              | Result                                                                                                                       |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Dead stages        | `group` in aggregation (documented, never run)                                                                               |
| Bypasses           | None (pipeline is linear)                                                                                                    |
| Missing stages     | `MasterOrchestratorService` orchestration entry (deferred)                                                                   |
| Duplicated stages  | None                                                                                                                         |
| Incorrect ordering | None (deterministic, spec-aligned)                                                                                           |
| Data loss          | Dedup drops `metadata`/`order` (L-3); `error.details`/`cause` dropped (L-9); Draft-agent plans rejected downstream (H-3/H-5) |
| State loss         | Execution state per-run, in-memory store; no cross-run persistence (correct for now)                                         |
| Error loss         | Errors preserved as structured `ResultError`; cause/detail dropped (L-9)                                                     |
| Context loss       | Silent truncation below warning threshold (M-5); `minTokens` unenforced (M-3)                                                |
| Result loss        | Strict/loose dedupe correct; validator-key vs dedupe-key mismatch edge (L-11)                                                |

---

## 12. Security Audit

| Check                          | Result                                                          | Severity     |
| ------------------------------ | --------------------------------------------------------------- | ------------ |
| Secret leakage (output path)   | **Step `output` unsanitized → leaks into `AggregatedResponse`** | **CRITICAL** |
| Secret leakage (metadata path) | Sanitized (recursive, arrays included)                          | OK           |
| Secret leakage (logs)          | pino logs carry ids/counters only; no payloads                  | OK           |
| Sensitive metadata             | `sanitizeRecord` key gaps (`pwd`, `passphrase`)                 | HIGH         |
| Error leakage                  | Errors carry code/message/ids only; `details` dropped           | OK           |
| Input/output validation        | Schema-first on all boundaries; output contract enforced        | OK           |
| Injection risks                | No code injection surfaces; regex-based sanitizer only          | LOW          |
| Prototype pollution            | No unsafe merges (`Object.entries` copy only)                   | OK           |
| Unsafe serialization           | Metadata truncation bounded; **outputs unbounded** (M-14)       | MEDIUM       |
| Arbitrary execution            | None (no `eval`/dynamic require)                                | OK           |
| Unbounded resource consumption | Concurrency not bounded (H-6); timer leak (C-3)                 | HIGH         |
| Retry abuse                    | Budget capped (`effectiveMaxAttempts`)                          | OK           |
| Concurrency abuse              | No semaphore (H-6)                                              | HIGH         |
| DoS                            | Fail-closed/limits exist but cost gate unenforced (H-5)         | MEDIUM       |

Security readiness score: **58 / 100** — the single CRITICAL output-leak dominates.

---

## 13. Performance Audit

- **Complexity:** matching/scoring/ordering are O(n·k) with small constants; topo-sort is
  O(V+E); no quadratic hot paths found.
- **Copies/serialization:** results copied with spread (`[...results]`); no repeated
  serialization; metadata size-bounded.
- **Parallelism:** `ParallelExecutionStrategy` launches all steps at once (no cap) — high
  throughput but unbounded fan-out (H-6).
- **Hybrid:** sequential (M-10) — does not deliver designed parallelism.
- **Token estimation:** constant-time approximation (len/4).
- **Memory:** per-execution in-memory result store; large outputs unbounded (M-14).
- **Primary bottleneck:** unbounded concurrent executor fan-out + orphaned executors after
  timeout/cancel (M-9, H-6). No optimization performed (audit only).

---

## 14. Test Audit

**Full suite (objective gate):**

- Run 1 (during audit): **489 passed / 489**, 50 files, Duration 15.22s.
- Run 2 (earlier, under load): **1 failed / 488 passed** — the flaky timeout test.
- Expected baseline from audit-report (489) **confirmed**.
- No skipped tests.

| Area        | Tests | Quality | Missing Coverage                                                                                                                                                           |
| ----------- | ----- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Intent      | 33    | Good    | Two-single-word saturation; single-word under low threshold; multi-intent flag                                                                                             |
| Context     | 54    | Good    | `minTokens` enforcement; compression no-op; snapshot ordering consistency                                                                                                  |
| Routing     | 100   | Good    | Draft-primary side effects; escalated `selectedAgent`; cost/min-confidence enforcement                                                                                     |
| Planning    | 88    | Good    | Dependency-from-agent propagation                                                                                                                                          |
| Execution   | 72    | Good    | **Load/stress timeout test; deadline cleanup; concurrency limit; executor abort; all-cancelled final state; dead flags**                                                   |
| Aggregation | 99    | Good    | **Secret-in-`output` leak test; `pwd`/`passphrase` keys; over-match false positives; disabled dedup; custom normalizer retries; `group` step; `AggregationConflictError`** |
| Foundation  | 29    | Good    | DI services; logger; schema shapes                                                                                                                                         |

**Quality:** assertions are meaningful, fixtures deterministic, no network/LLM/fs deps, negative
paths well covered. **Flakiness:** 1 test (see C-2). The suite escapes the flake only because it
never loads the event loop — a stress test is the missing guard.

---

## 15. Type Safety Audit

- `tsc --noEmit`: **PASS**.
- No `any` misuse, no unsafe casts, no non-null assertions found in source.
- Zod schema-first validation on every external boundary; internal interfaces are explicit.
- Minor: `StatusCalculator` signature mismatch (I-4); `resolve` assigned after `setTimeout` in
  `createDeadline` (fragile ordering, INFO — F10).

---

## 16. Observability Audit

- Execution/plan/step/agent IDs propagate through logs and events.
- State transitions, errors, durations, retry counts, final status are captured in
  `ExecutionMetrics`/events.
- **Gaps:** `EXECUTION_CANCELLATION_ENABLED`, `EXECUTION_PARALLEL_ENABLED`, `EXECUTION_CONDITIONAL_ENABLED`,
  `EXECUTION_IDEMPOTENCY_ENABLED` are dead — event/metadata feature flags promise observability
  toggles that do nothing. No sensitive data in logs (verified). No cross-run correlation beyond
  trace IDs (acceptable for now).

---

## 17. Configuration Audit

Dead / unenforced configuration surface (the single largest maintainability concern):

| Key                                                                         | Module              | Status                    |
| --------------------------------------------------------------------------- | ------------------- | ------------------------- |
| `INTENT_MULTI_INTENT_ENABLED`                                               | intent              | DEAD                      |
| `INTENT_HIGH_THRESHOLD`                                                     | intent              | Metadata-only             |
| `INTENT_DEFAULT_STATUS`                                                     | intent              | DEAD                      |
| `CONTEXT_MIN_TOKENS`                                                        | context             | Not enforced              |
| `CONTEXT_COMPRESSION_ENABLED`                                               | context             | Inert after normalization |
| `ROUTING_DEFAULT_STRATEGY`                                                  | routing             | DEAD                      |
| `ROUTING_DEFAULT_EXECUTION_MODE`                                            | routing             | DEAD                      |
| `ROUTING_MAX_COST`                                                          | routing             | Unenforced                |
| `maxRoutingCost` / `minConfidence` / `requiredPermissions` / `allowedRoles` | routing constraints | Validated, never enforced |
| `EXECUTION_DEFAULT_TIMEOUT_MS`                                              | execution           | DEAD                      |
| `EXECUTION_DEFAULT_RETRY_ATTEMPTS`                                          | execution           | DEAD                      |
| `EXECUTION_CANCELLATION_ENABLED`                                            | execution           | DEAD                      |
| `EXECUTION_IDEMPOTENCY_ENABLED`                                             | execution           | DEAD                      |
| `EXECUTION_PARALLEL_ENABLED`                                                | execution           | DEAD                      |
| `EXECUTION_CONDITIONAL_ENABLED`                                             | execution           | DEAD                      |
| `EXECUTION_MAX_CONCURRENT_STEPS`                                            | execution           | Metric-only, not a limit  |
| `isExecutionFeatureEnabled()`                                               | execution           | Never called              |
| `AggregationPolicy` / `OutputAggregator` / `AggregationWorkspace`           | aggregation         | Dead public types         |

No conflicting defaults, no duplicate config, no unsafe defaults found (all limits validated ≥ 1).

---

## 18. Error Handling Audit

- Consistent hierarchy per module: `OrchestratorError` base with codes + `retryable`;
  module roots `IntentClassificationError` / `ContextBuildError` / `RoutingError` /
  `ExecutionPlanningError` / `ExecutionEngineError` / `AggregationError`.
- **Gap:** routing error classes (`NoRouteError`, `LowConfidenceRouteError`,
  `AgentUnavailableError`) and `RoutingStatus.Failed` are never produced — the engine returns
  escalation statuses instead (L-5).
- **Gap:** aggregation drops `ExecutionError.details`/`cause` (safe but diagnostic loss, L-9).
- Propagation is sound; the engine catches all executor errors via `toExecutionError`.

---

## 19. Data Flow Audit

| Artifact             | Preserved                         | Transformed        | Dropped/Mutated/Exposed                         |
| -------------------- | --------------------------------- | ------------------ | ----------------------------------------------- |
| `RequestContext`     | Trace/request IDs                 | —                  | —                                               |
| `IntentResult`       | Intent id, confidence, candidates | → RouteRequest     | —                                               |
| `RouteDecision`      | Selected agent, mode, confidence  | → PlanningRequest  | **Agent dependencies dropped** (F-RTE-4)        |
| `ExecutionPlan`      | Steps, deps, policy, timeouts     | → ExecutionRequest | —                                               |
| `ExecutionContext`   | Request + plan                    | —                  | —                                               |
| `ExecutionResult`    | State, step results, metrics      | → AggregationInput | **Step `output` not sanitized → exposed** (C-1) |
| `AggregatedResponse` | Outputs, errors, warnings, stats  | Final              | Metadata-only truncation (M-14)                 |

---

## 20. AG-002 / AG-003 / AG-004 Boundary Audit

| Component     | AG-001 Responsibility (implemented) | AG-002/003/004 Responsibility (contract only) | Leakage?                                                    |
| ------------- | ----------------------------------- | --------------------------------------------- | ----------------------------------------------------------- |
| Memory        | Context _request_ contract          | Read/write/expire namespaced state            | **None** (provider interfaces only)                         |
| Knowledge     | Context _request_ contract          | Chunk/embed/retrieve/cite                     | **None**                                                    |
| Tools         | Executor abstraction                | Tool registry, approval, circuit breakers     | **None** (no tool implementation)                           |
| Orchestration | Plan/delegate/policy                | —                                             | `MasterOrchestratorService` missing (I-1) but not a leakage |

**No responsibility leakage.** AG-001 correctly depends on interface abstractions for the three
downstream managers.

---

## 21. OpenClaw Readiness

Architectural readiness for future OpenClaw integration is **good**:

- Agent abstraction: `AgentExecutor` + `ExecutorRegistry` ✅ (though only a `FakeAgentExecutor`
  exists — ready seam).
- Execution abstraction: mode strategies + lifecycle ✅
- Gateway independence: request/context contracts are transport-agnostic ✅
- Session independence: no session-coupled state in core ✅
- Transport independence: `RequestContext` carries origin, not transport ✅
- Tool independence: `AgentExecutor` doesn't hardcode tools ✅
- Memory independence: provider interfaces only ✅

**Gaps:** no `AbortSignal` propagation to executors (M-9), concurrency bounding absent (H-6),
and the pipeline has no standalone orchestrator entry (I-1). These are integration-blocking,
not architecture-blocking.

---

## 22. Architectural Debt

| ID   | Category                                           | Impact                                                             |
| ---- | -------------------------------------------------- | ------------------------------------------------------------------ |
| AD-1 | Dead config surface (10+ keys)                     | Misleading ops knobs; maintenance cost                             |
| AD-2 | `FakeAgentExecutor` as default                     | Integration risk (executor semantics untested against real agents) |
| AD-3 | `group` step + dead aggregation types              | API promises unfulfilled; consumer confusion                       |
| AD-4 | Routing constraint fields validated-but-unenforced | Security/ops gap (cost caps are a DoS control)                     |
| AD-5 | Draft agents in candidate set                      | Semantic inconsistency; cascades to planner                        |
| AD-6 | Timestamp-only determinism exception               | Documented; acceptable                                             |
| AD-7 | `MasterOrchestratorService` absent                 | Pipeline has no single entry point to test end-to-end              |

---

## 23. Missing Features

**A. Required before production-ready (from audit):**

- Sanitize step `output` (C-1)
- Make timeout enforcement race-safe (C-2)
- Enforce `EXECUTION_MAX_CONCURRENT_STEPS` / abort executors (H-6, M-9)
- Wire or remove dead config flags (F-X-1)
- Enforce routing cost/min-confidence constraints (H-5)
- Filter non-routable agents from candidate/multi-agent sets (H-3, M-7)
- Add security + stress regression tests (C-1, C-2)

**B. Required for future integrations:**

- `MasterOrchestratorService` end-to-end entry point
- Real `AgentExecutor` wiring (OpenClaw/team agents)
- AG-002/003/004 provider implementations

**C. Optional future improvements:**

- Hybrid true-parallel middle wave (M-10)
- AI-based intent classifier (abstraction ready)
- Route telemetry for catalog KPIs

**D. Intentionally deferred:**

- OpenClaw gateway integration (per audit-report §19)
- LLM intent detection (per audit-report §8)
- Namespace/identity enforcement (platform concern)

---

## 24. Sprint 8 Recommendation

**Decision: Option B — AG-001 core is complete; move to integration/hardening.**

Evidence:

- All seven sprints implement their required scope with functional coverage and a clean,
  layered architecture; the test baseline (489) is met.
- The remaining defects are **reliability/security hardening items**, not missing core features:
  two CRITICALs (output sanitization, timeout race), dead-config cleanup, constraint
  enforcement, and integration wiring.

**Proposed smallest next sprint (do NOT implement in this audit):**
A **"Sprint 8 — Hardening & Integration"** (not more numbered feature sprints):

1. Fix C-1 (sanitize `output` + regression test), C-2 (elapsed-vs-budget recheck + clear deadline
   timer + stress test).
2. Enforce/remove dead config flags; enforce `EXECUTION_MAX_CONCURRENT_STEPS` and
   `maxRoutingCost`/`minConfidence`.
3. Pre-filter routable candidates; clear stale `selectedAgent` on escalation; propagate agent
   dependencies to plans.
4. Execute the documented `group` step or remove it.
5. Stand up `MasterOrchestratorService` + a real `AgentExecutor` fixture for end-to-end pipeline
   integration tests.
6. Add missing security/stress/concurrency tests.

---

## 25. Future Roadmap Recommendation

Sprints 1–7 were correctly sequenced (Foundation → detection → context → routing → planning →
execution → aggregation). Future work should NOT blindly continue feature numbering; it should
be a **hardening** sprint (above), then **integration** with AG-002/003/004 and the OpenClaw
gateway, then **observability/performance** instrumentation (route telemetry, cost metrics), then
**security** test expansion. Only after these should adaptive routing / AI intent classification
be considered.

---

## 26. Final Scorecard

| Category              | Score (0–100) |
| --------------------- | ------------- |
| Architecture          | 90            |
| Interfaces            | 82            |
| Intent Detection      | 68            |
| Context               | 74            |
| Routing               | 70            |
| Planning              | 88            |
| Execution             | 66            |
| Aggregation           | 82            |
| Security              | 58            |
| Testing               | 85            |
| Observability         | 70            |
| Performance           | 72            |
| Configuration         | 60            |
| Error Handling        | 80            |
| OpenClaw Readiness    | 78            |
| Integration Readiness | 72            |

| Overall metric            | Score        |
| ------------------------- | ------------ |
| **Overall**               | **82 / 100** |
| **Production readiness**  | **64 / 100** |
| **Integration readiness** | **72 / 100** |
| **Test readiness**        | **85 / 100** |
| **Security readiness**    | **58 / 100** |

---

## 27. Blocking Issues

1. **[CRITICAL] C-1** — Sensitive step `output` leaks into aggregated responses
   (`aggregation/normalizers/index.ts:137`, `aggregation/formatters/index.ts:79`).
2. **[CRITICAL] C-2** — Overall-execution-timeout race can report over-budget runs as `COMPLETED`
   under load (`execution/engine/index.ts:152-156`); verified flaky test + 1.5% direct-engine rate.

---

## 28. Non-Blocking Issues

**HIGH (7):** H-1 intent single-word saturation; H-2 `INTENT_MULTI_INTENT_ENABLED` dead; H-3
Draft-agent primary + stale `selectedAgent`; H-4 routing default-strategy/mode dead; H-5 routing
cost/confidence/permission constraints unenforced; H-6 concurrency limit not enforced; H-7
sanitizer key-list gaps.

**MEDIUM (14):** M-1 `INTENT_HIGH_THRESHOLD` metadata-only; M-2 `INTENT_DEFAULT_STATUS` dead; M-3
`CONTEXT_MIN_TOKENS` unenforced; M-4 compression inert; M-5 silent context truncation; M-6 agent
dependency graph lost; M-7 Draft agents in multi-agent plans; M-8 six dead execution flags; M-9
executor never aborted; M-10 hybrid sequential; M-11 sanitizer over-match; M-12 `group` step dead;
M-13 custom-normalizer retry loss; M-14 unbounded outputs.

**LOW (9):** L-1..L-11 (intent `keywordWeight` dead; no threshold cross-validation; dedup metadata
loss; snapshot ordering divergence; dead routing errors; parallel deps ignored; all-cancelled
`Completed`; `dependencyOrder` cycles; error detail loss; unreachable `Partial` group; key mismatch).

**INFO (10):** I-1 `MasterOrchestratorService` absent; I-2 barrel missing aggregation; I-3 dead
aggregation types; I-4 `StatusCalculator` mismatch; I-5 `completedAt` exception; plus keyword-group
drift, rules snapshot, empty errors channel, FNV collision note, `defaultConstraints` unused.

---

## 29. Recommended Next Steps

1. Create the **Sprint 8 — Hardening & Integration** work item (per §24), fixing the two CRITICALs
   first.
2. Add regression tests for both CRITICALs: secret-in-`output` leak, and a stress/load test that
   repeatedly exercises the overall timeout under event-loop load.
3. Sweep all module config schemas against actual reads; implement or remove every dead key.
4. Enforce routing constraints and concurrency bounds; filter routable candidates.
5. Stand up `MasterOrchestratorService` + real `AgentExecutor` and an end-to-end pipeline test.
6. Optionally add route telemetry to support catalog KPIs (routing accuracy, escalation time).

---

## 30. Audit Integrity

- **No source file was modified.** `git status` verified clean (only the untracked
  `prompts/audit-report` prompt file and this audit report).
- Test/typecheck/lint/build runs are read-only.
- Stress probes were created under the OS temp directory (outside the repo) and left there.
- Per audit-report §32: only `docs/ag-001-sprints-1-7-audit-v1.md` was created.
