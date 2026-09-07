# Multi-Agent Coordination & Collaboration — Sprint 20 v1

## 1. Objective

Introduce a **generic, reusable coordination layer** that sits **strictly above**
the Sprint 19 Agent Platform. It lets AG-001 compose multiple managed agents into
one deterministic, bounded run — sequential, parallel, pipeline, debate or hybrid —
without business agents (Client AI / Freelancer AI / Marketplace AI / Marketing AI /
Admin AI) living in this module. Sprint 20 delivers only the reusable plumbing those
agents will be built against later.

The layer guarantees:

- **deterministic execution** — topological order, stable tie-breaks, validated
  statuses, and a fail-closed state machine;
- **bounding** — per-run task/concurrency/deadline limits and per-task timeouts are
  server constants validated at plan time;
- **platform-first invocation** — agents are only ever driven through the runtime
  executor, which enforces the Sprint 19 gate and lifecycle lease (the coordinator
  deliberately **never double-claims** a platform slot);
- **no silent bypasses** — no LLM, no heuristic, no degraded-path short-circuits;
  conflicts are detected deterministically and resolved only per an explicit policy;
- **safe observability** — typed events (never payloads/secrets) and deterministic
  in-memory metrics.

## 2. Scope

In scope:

- `src/agents/agent-platform/coordination/` domain module: contracts, constants,
  errors (15 typed subclasses of `CoordinationError`), Zod schemas, deterministic
  ids, task dependency graph, task/coordination state machines, shared state store,
  agent selection, task decomposition + planner, coordinator-owned retry, conflict
  detection/resolution, result aggregation, an authorized message bus, invocation
  adapter, event log, metrics, and the execution coordinator.
- `ProductionComposition` wiring: `AgentSelector`, `CoordinationPlanner`,
  `RuntimeAgentInvocationAdapter`, `CoordinationEventLog`, `CoordinationMetrics`,
  and a `CoordinationCoordinator` — all composed against the real executor.
- `GET /healthz` `coordination` block + `GET /api/coordination/status` endpoint.
- Full unit + integration suite.

Out of scope (deferred): durable persistence for coordination events/metrics,
long-lived coordination windows across process restarts, multi-node coordination
locking, and any business-specific coordination recipes.

## 3. Architecture

```
                    CoordinationRequest (AG-001 / runtime)
                               │
                               ▼
  ┌────────────────── CoordinationPlanner ─────────────────┐
  │  TaskDecomposition (modes) → AgentSelector (vet ALL)   │
  │  TaskDependencyGraph (cycles/dupes/deadlock) → Plan    │
  └──────────────────────────┬─────────────────────────────┘
                             ▼
  ┌────────────────── CoordinationCoordinator ─────────────────┐
  │  CoordinationStateStore (statuses, results, conflicts)     │
  │  dispatch loop: graph.readyTasks → per-run/per-agent limit │
  │  retry (coordinator-owned) · timeouts · cancellation       │
  │  detectConflicts → resolveConflicts → aggregateResults     │
  └──────────────────────────┬──────────────────────────────────┘
                             │ invoke(cannot double-claim)
                             ▼
             RuntimeAgentInvocationAdapter
                             │ (executor policy: maxRetries 0, one step)
                             ▼
                  ProductionAgentExecutor
                     └──► AgentPlatformGateway (Sprint 19 gate + lease)
```

Invocation is the **only** point the coordinator drives an agent. The adapter pins
executor retries to zero and `failureBehavior` to `FailFast` for the single step; all
retries and deadlines belong to the coordinator.

## 4. Contracts & validation (`types.ts`, `schemas.ts`)

- `CoordinationMode`: `SINGLE | SEQUENTIAL | PARALLEL | PIPELINE | DEBATE | HYBRID`.
- `TaskStatus`: `PENDING | READY | RUNNING | COMPLETED | FAILED | CANCELLED | SKIPPED |
TIMED_OUT`; `CoordinationStatus`: `PENDING | RUNNING | COMPLETED | PARTIAL | FAILED |
CANCELLED | TIMED_OUT`; `CoordinationPhase` mirrors execution stages.
- `CoordinationLimits` (bounded): `maxTasks` (≤16), `maxConcurrentTasks`,
  `maxTasksPerAgent`, `globalTimeoutMs`, `defaultTaskTimeoutMs`, `maxMessageBytes`.
- Every boundary payload (`CoordinationRequest`, task input, message, task result,
  message payload size) is validated with **strict** Zod schemas; unknown fields are
  rejected. `cancellation: AbortSignal` is transient — stripped before parsing and
  never treated as schema data.
- Both `CoordinationRequest` and `CoordinationTaskInput` **require `taskId`**; a plan
  cannot carry a nameless task.

## 5. Task dependency graph (`dependency-graph.ts`)

Directed graph over plan tasks: duplicate/self/unknown-target rejection, cycle
detection (`CoordinationCycleError` — never executed), deterministic stable Kahn
topological order, `readyTasks` (required deps all `COMPLETED`), `blockedTasks`,
`dependentClosure` (transitive dependents), and `assertNoDeadlock`.

## 6. Decomposition & planner (`task-decomposition.ts`)

- AG-001 may supply **pre-built tasks** (preferred, deterministic) or a
  `participatingAgents` list that the planner auto-decomposes into mode-shaped tasks:
  `SINGLE`→1 task, `SEQUENTIAL`/`PIPELINE`→chain, `PARALLEL`/`DEBATE`→no edges,
  `HYBRID`→chain (v1).
- `resolveLimits` applies server defaults and rejects out-of-range values
  (`CoordinationLimitError`). Per-task `timeoutMs` is capped by `globalTimeoutMs`.
- Every plan is vetted by `AgentSelector.assertAll` before it is committed — a
  rejected agent fails the plan before any execution.

## 7. Agent selection (`agent-selection.ts`)

Deterministic pre-flight vetting per task (never claims a platform slot):

registered identity → lifecycle readiness (default `READY`/`RUNNING`) → a resolvable
executor claiming the agent → executor availability → declared **and enabled**
capabilities superset → tool allowlist superset → platform concurrency headroom
(`active < maxConcurrentExecutions`). Rejections are machine-readable reasons
(`NOT_REGISTERED`, `NOT_READY`, `NO_EXECUTOR`, `EXECUTOR_UNAVAILABLE`,
`CAPABILITY_MISSING`, `CAPABILITY_DISABLED`, `TOOL_NOT_ALLOWED`, `CONCURRENCY_LIMIT`).

## 8. Task & coordination state machines (`task-state.ts`, `coordination-state.ts`)

- Task machine: `PENDING → READY → RUNNING → {COMPLETED|FAILED|TIMED_OUT}` plus
  `{SKIPPED|CANCELLED}` from pre-start states; terminal states immutable. Illegal
  transitions throw `CoordinationIllegalStateError` with explicit reasons.
- `CoordinationStateStore` is the single source of truth for one run: statuses,
  validated results, conflicts, phase, cancellation/deadline flags, deadline timer
  (`armDeadline`, set-and-`unref`), and deterministic aggregate `status()`.

## 9. Coordinator (`coordinator.ts`)

`coordinate(request)` runs plan → dispatch → collect → conflict → aggregate →
finalize, with typed events and metrics at every stage. Key guarantees:

- **Concurrency**: bounded by `limits.maxConcurrentTasks` and `maxTasksPerAgent`;
  runnable tasks ordered by priority then plan order.
- **Failure policies**: `FAIL_FAST` (cancel outstanding queued work),
  `SKIP_DEPENDENTS` / `CONTINUE_INDEPENDENT` (skip the dependency closure),
  `REQUIRE_ALL` (any non-completion → `FAILED`), `BEST_EFFORT`.
- **Retries are coordinator-owned**: `decideRetry` bounds retries, only retries
  retryable errors, and applies exponential backoff capped at `maxBackoffMs`; the
  backoff wait is abortable.
- **Timeout & deadline**: per-task `timeoutMs` via executor policy; the global
  deadline marks `TIMED_OUT` and cancels outstanding work; external `AbortSignal`
  cancels the run (`CANCELLED`).
- **Status derivation**: failures → `FAILED` for `FAIL_FAST`/`REQUIRE_ALL`, else
  `PARTIAL`; skips/timeouts → `PARTIAL`; `mustReview` aggregation → `PARTIAL`; else
  `COMPLETED`. Exposed errors are normalized to safe `ExecutionError`s (no details,
  no stack traces).

## 10. Conflicts & aggregation (`conflict.ts`, `aggregation.ts`)

`detectConflicts` is deterministic from results/statuses only: `duplicate_results`,
`contradictory_outputs`, `incompatible_statuses` (`REQUIRE_ALL`), `agent_disagreement`
(`DEBATE`), `missing_dependency_output`. `resolveConflicts` applies the plan policy:

`PRIORITY` (highest priority → `selectedTaskId`), `FIRST_SUCCESS` (earliest in plan
order), `ALL_RESULTS`, `REVIEW_REQUIRED` (`review_required`), `FAIL_ON_CONFLICT`
(fail → `CoordinationConflictError`). Aggregation: `COLLECT` (keyed by task),
`MERGE` (deep merge of JSON-safe outputs), `BEST_RESULT` (priority-then-order),
`CONSENSUS` (strict majority by deep-equal group, else review), `REVIEW` (wrapped,
`mustReview`). Counts (`successCount`, `failureCount`, `skippedCount`, `totalCount`)
are always derived and never trusted from the executor.

## 11. Messages (`messages.ts`)

Authorized, bounded coordination messages: server-imposed byte cap
(`assertMessageSize`) and per-coordination cap; send/read enforce participant
membership; `*` broadcasts to all participants; reads only surface messages the
reader may see. Append-only in-memory log.

## 12. Invocation (`invocation.ts`)

`RuntimeAgentInvocationAdapter` is the only driving point. It resolves the runtime
executor for the task's agent, builds a deterministic execution request per attempt
(`exec_<prefix>_<coordinationId>_<taskId>_attempt<N>` — parseable by AG-001's
`parseRequestId`), pins `maxRetries: 0`, `failureBehavior: FailFast`, `maxSteps: 1`,
and normalizes thrown executor errors into safe `InvocationOutcome`s (never leaks).

## 13. Runtime surface (`runtime.ts`)

- `GET /healthz` → new `coordination` block: `{ healthy, activeCoordinations,
activeTaskCount, eventCount }` (safe counts only, never secrets).
- `GET /api/coordination/status` → coordinator status + event-log totals + latest
  events.

## 14. Files

- `src/agents/agent-platform/coordination/{constants,types,errors,schemas,events,metrics,ids,task-state,dependency-graph,task-decomposition,agent-selection,coordination-state,conflict,aggregation,retry,messages,invocation,coordinator,index}.ts`
- `src/app/{composition-root,runtime}.ts` (wiring + health/status surface)
- Tests: `tests/unit/agents/agent-platform/coordination/*` (87), `tests/unit/app/coordination-integration.test.ts` (2).

## 15. Verification

- `npx tsc --noEmit` — clean.
- `npx eslint src tests` — clean.
- `npx prettier --check` (changed files) — clean.
- `npx vitest run` — **1781 tests / 163 files pass** (coordination unit 87,
  app coordination integration 2; all pre-existing suites green).
- `npm run build` (`tsc -p tsconfig.build.json`) — clean.
- Runtime smoke: `/healthz` exposes the `coordination` block (`healthy:true`);
  `/api/coordination/status` returns coordinator status; a single-task coordination
  over AG-101 completes `COMPLETED` through the real executor + platform gate.
