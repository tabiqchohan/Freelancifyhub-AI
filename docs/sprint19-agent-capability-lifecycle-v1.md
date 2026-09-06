# Agent Capability Framework & Lifecycle — Sprint 19 v1

## 1. Objective

Introduce a **formal Agent Platform** that sits cleanly on top of the AG-001
master orchestrator and the Agent Catalog. It gives every agent:

- a **contract** (identity, capabilities, permissions, execution modes, limits,
  tool allowlist, dependencies, configuration) that is server-controlled and
  immutable at runtime;
- an **operational lifecycle** (READY / RUNNING / DRAINING / PAUSED / DISABLED /
  FAILED / TERMINATED) independent of the catalog's static deployment status;
- an **execution gate** — the single admission point through which AG-001
  executes a managed agent (lifecycle readiness, version, capability claim,
  execution-mode claim, permission claim, concurrency limit);
- **defense-in-depth tool allowlisting** enforced at call time by the agentic
  loop (Sprint 18 §8).

The platform is additive and backward-compatible: it **does not redesign**
AG-001/AG-002/AG-003/AG-004 or any existing runtime layer. All pre-existing
tests remain green.

## 2. Scope

In scope:

- `src/agents/agent-platform/` domain module: constants, errors (13 typed
  subclasses of `AgentPlatformError`), contracts, Zod schemas, events, lifecycle
  state machine + controller, metrics, definition registry, execution gateway,
  routing integration, and built-in definitions.
- `ProductionAgentExecutor` integrate the execution gate for **platform-managed
  agents** (unmanaged runtime agents keep legacy behavior).
- Agentic loop **tool allowlist**: the platform lease carries an immutable
  `allowedTools` list that both narrows the tools shown to the model and rejects
  any off-list call at preflight with `TOOL_NOT_ALLOWED`.
- Compose-root wiring: platform registry (with AG-101 mirror of the runtime
  agent + AG-102 definition-only), gateway, routing decorator, and executor gate.
- `GET /healthz` `platform` block exposing a safe aggregate snapshot.
- Full unit + integration + runtime smoke suite.

Out of scope (deferred): long-lived execution windows across process restarts,
metrics/event sinks to durable storage, agent auto-scaling, and multi-node
leader election for lifecycle decisions.

## 3. Architecture

```
Agent Catalog (static: Draft / InDevelopment / Production / Retired)
        │  (unchanged)
        ▼
┌────────────────────────── Agent Platform (Sprint 19) ───────────────────────┐
│  AgentDefinitionRegistry (definitions + lifecycle + discovery + snapshot)    │
│        │                                │                                    │
│   AgentLifecycleController   PlatformAwareRoutingRegistry (decorator)        │
│        │                                │                                    │
│        ▼                                ▼                                    │
│  AgentPlatformGateway  ◄────  AG-001 RoutingEngine (routing availability =   │
│   beginExecution /endExecution          lifecycle readiness)                 │
└───────────────┬──────────────────────────────────────────────────────────────┘
                │ lease (agentId, version→, lifecycle slot, allowedTools)
                ▼
ProductionAgentExecutor  (gates managed agents; finally-closes the lease)
        │  allowedTools▼
        └──► AgenticLoopService (narrows tool list + TOOL_NOT_ALLOWED preflight)
                │
                ▼
           AG-004 ToolManager  (still the sole execution/authorization authority)
```

- The executor claims exactly the capability ids / permission ids declared in
  the AG-101 mirror, so identity and capability are the **same contract seen
  from two layers** (`agentDefinitionFromRuntimeAgent`).
- Denials are **not** authorization decisions: AG-004 / request-actor
  authorization still applies independently at the tool/action boundary.

## 4. Contracts (`types.ts`)

- `AgentExecutionMode`: `Deterministic | Reasoning | Agentic`.
- `AgentDefinition` (immutable): `agentId, name, version, description, team,
category, status, capabilities, executionModes, allowedTools, permissions,
limits, dependencies, configuration`.
- `AgentLimits`: `maxExecutionTimeMs, maxReasoningTurns, maxToolCalls,
maxContextBytes, maxOutputBytes, maxConcurrentExecutions, maxTokenBudget?`.
- `AgentExecutionGateInput` / `AgentExecutionLease`: the lease carries the
  immutable tool allowlist for defense in depth.
- `AgentPlatformStatusSnapshot`: safe per-state counts + `activeExecutions`
  - `healthy`.

## 5. Validation (`schemas.ts`)

Every definition is re-validated on registration via `parseAgentDefinition`
(identity `AG-NNN`, semantic version, capability `domain.action`, permission
`domain.action`, tool `^[a-z][a-z0-9_-]{0,63}$`, execution mode enum, limits).
`agentLimitsInputSchema` fields are all optional; defaults are applied at parse
time. The definition schema is `.strict()` — unknown fields are rejected.

## 6. Execution modes (Sprint 19 §7)

The executor computes the effective mode with `executionModeFor(agent)`
(capability-driven, mirroring the reasoning resolution precedence): `Agentic` if
`agent.agentic`, else `Reasoning` if `agent.reasoning`, else `Deterministic`.
The gate checks the claim against the definition, so a reasoning-capable agent
cannot run under a mode the definition does not list.

## 7. Lifecycle (`lifecycle.ts`)

- `AgentLifecycleStateMachine`: deterministic transition table; no arbitrary
  mutation.
- `AgentLifecycleController` (synchronous + bounded → concurrency-safe on the
  single Node thread): `register/activate/pause/resume/drain/disable/fail/
recover/terminate/beginExecution/endExecution/unregister`.
- `beginExecution` marks `RUNNING` and increments `active`; only READY/RUNNING
  agents accept new work. `endExecution` returns to READY on the last execution
  and auto-disables a draining agent at zero active.
- `summary()` / `snapshot()` give per-state counts + total active executions.

## 8. Metrics (`metrics.ts`)

Gauges are registry/gateway-computed; counters are explicit:

- `recordLifecycleTransition`, `recordRejectedExecution`,
  `recordCapabilityDenial`, `recordPermissionDenial`, `recordToolDenial`,
  `recordExecutionLimitDenial`, `setAgentCounts(AgentLifecycleCounts)`,
  `recordExecutionStarted(activeExecutions)`,
  `recordExecutionCompleted(durationMs)`, `snapshot()`.

## 9. Events (`events.ts`)

Typed lifecycle + policy events (`agent.registered`, `agent.ready`,
`agent.paused`, `agent.capability.denied`, `agent.permission.denied`,
`agent.execution.denied`, `agent.tool.denied`, …). `AgentPlatformEventLog`
supports paginated query and category/severity derivation. Observability is
never load-bearing: appends are fire-and-forget and never affect admission.

## 10. Built-ins (`builtin.ts`)

- **AG-101 — Project Description Agent** (Core / Production, Deterministic,
  capability `project.read.describe`, no tools/permissions, concurrency 4).
- **AG-102 — Budget Estimator** (Marketplace / Testing, Reasoning, capability
  `budget.estimate`, permission `knowledge.read`, optional dependency on AG-101).

The composition root derives the AG-101 mirror from the **registered runtime
agent** (identity + capabilities stay aligned) instead of the static built-in,
then registers AG-102 definition-only.

## 11. Routing integration (`routing.ts`)

`PlatformAwareRoutingRegistry` decorates the inner AG-001 routing registry so
platform-managed agents expose their **live lifecycle as routing availability**
(READY/RUNNING only). Unmanaged agents are untouched (backward compatible).
`withPlatformAwareness` is idempotent.

## 12. Executor + agentic integration

- `ProductionAgentExecutorOptions.agentPlatform` (optional). Managed agents gate
  via `beginExecution` after availability check and `isAgentExecutable`, then
  run inside `try/finally` calling `endExecution(startedAtMs)` with
  `performance.now()` so durations stay deterministic. Lease closes on any path
  (success, reasoning failure, thrown error). Unmanaged agents skip the gate.
- `AgenticLoopRunInput.allowedTools` (optional). When present, the loop (a)
  narrows `listTools` so the model never sees denied tools, and (b) rejects any
  off-list call at preflight with `TOOL_NOT_ALLOWED`. Empty means deterministic /
  no tool access. Absent means no platform restriction (legacy behavior).

## 13. Gate order (`gateway.ts`)

`beginExecution` validates in fixed order: registered identity → lifecycle
readiness (reserves slot) → version → capability claims → execution-mode claim →
permission claims → concurrency (`active > maxConcurrentExecutions`). Every
rejection is a normalized `PlatformGateFailure` + typed policy event + metric
counter, and never leaks a running slot (`endExecution` is called on each
denial). `isToolAllowed` / `isPlatformManaged` are fail-closed.

## 14. Health (`runtime.ts`)

`GET /healthz` now includes a `platform` block from
`platformRegistry.snapshot()` (registered/ready/running/paused/draining/disabled/
failed/terminated/activeExecutions/healthy). Never exposes secrets or ids beyond
counts. The overall `status` computation is unchanged.

## 15. Files

- `src/agents/agent-platform/{constants,errors,types,schemas,events,lifecycle,metrics,registry,gateway,routing,builtin,index}.ts`
- `src/agents/runtime/executor.ts` (gate + `agentPlatform` option + helpers)
- `src/agents/runtime/agentic/{contracts,loop}.ts` (`allowedTools`)
- `src/app/{composition-root,runtime}.ts` (platform wiring + health block)
- Tests: `tests/unit/agents/agent-platform/*` (60), `tests/unit/agents/runtime/executor-platform.test.ts` (4),
  `tests/unit/agents/runtime/agentic/loop.test.ts` (+3), `tests/unit/app/platform-integration.test.ts` (4).

## 16. Verification

- `npx tsc --noEmit` — clean.
- `npx eslint src tests` — clean.
- `npx vitest run` — **1694 tests / 152 files pass** (agent platform 60, executor×platform 4,
  agentic allowlist +3, app platform 4; all pre-existing suites green).
- `npm run build` (`tsc -p tsconfig.build.json`) — clean.
- Runtime smoke: `/healthz` exposes the `platform` block
  (`registered:2, ready:1, healthy:true`); `POST /runtime/request` returns **200** through the
  platform gate end-to-end.
