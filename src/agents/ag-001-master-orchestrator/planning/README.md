# AG-001 Execution Planner (Sprint 5)

Deterministic Execution Planner for the Master Orchestrator.

## Purpose

Consumes an `AgentRequest` (Sprint 1), `IntentResult` (Sprint 2),
`ContextSnapshot` (Sprint 3) and `RouteDecision` (Sprint 4) and produces a
declarative `ExecutionPlan`: how the selected route should be executed later,
in what mode, with which steps, dependencies, conditions, policies and
statistics.

The planner describes HOW a route will be executed. It never executes
anything.

## Responsibilities

- Route → plan transformation for SINGLE, SEQUENTIAL, PARALLEL, CONDITIONAL and HYBRID modes.
- Deterministic execution-step creation with input/output references.
- Deterministic dependency graph building and topological validation.
- Declarative condition and branch representation (never evaluated).
- Execution policies, retry metadata and failure policies as planning data.
- Safe deterministic optimization (duplicate/unreachable steps, merged metadata).
- Constraint enforcement (max steps, depth, parallel branches, total time).
- Deterministic plan statistics (steps, agents, dependencies, depth, stages).
- Structured, typed errors following AG-001 conventions.
- Logging of planning metadata only (ids, mode, counts, status — never content).

## Non-responsibilities

- No agent execution.
- No agent-to-agent communication.
- No memory/knowledge retrieval, no tool execution, no LLM/API calls.
- No external service calls, no queueing, no workers.
- No response generation, no business logic.
- No actual workflow execution.

## Architecture

```
planning/
  types/        contracts: ExecutionPlan, ExecutionStep, conditions, policies, stats
  errors/       typed error hierarchy
  config/       zod-driven planning configuration (limits, defaults, flags)
  interfaces/   contracts: strategy, builder, optimizer
  strategies/   mode-specific strategies (single/sequential/parallel/conditional/hybrid)
  builders/     ExecutionPlanBuilder orchestration
  dependencies/ dependency graph + deterministic topological validation
  validators/   planning request / route / constraints / plan validation
  optimizers/   SafePlanOptimizer (safe deterministic optimizations)
  utils/        step/condition/branch ids, references, policies
  index.ts      barrel
```

## Input

`PlanningRequest`:

- `request` — `AgentRequest` (Sprint 1)
- `intent` — `IntentResult` (Sprint 2)
- `context` — `ContextSnapshot` (Sprint 3)
- `route` — `RouteDecision` (Sprint 4)
- `role` — `UserRole`
- `constraints?` — optional `ExecutionConstraints`
- `requestId?`, `traceId?`

## Output

`ExecutionPlan`:

- `planId`, `version`, `createdAt`, `requestId`, `traceId`, `intentId`, `role`
- `mode` — `ExecutionMode` (single/parallel/sequential/conditional/hybrid)
- `steps` — ordered `ExecutionStep[]`
- `dependencies` — `ExecutionDependency[]`
- `conditions` — `ExecutionCondition[]`
- `branches` — `ExecutionBranch[]`
- `policy` — `ExecutionPolicy`
- `constraints` — `ExecutionConstraints`
- `metadata` — `ExecutionMetadata`
- `warnings` — `PlanningWarning[]`
- `statistics` — `PlanningStatistics`

## Route → Plan transformation

| Route decision execution mode | Plan structure                                         |
| ----------------------------- | ------------------------------------------------------ |
| Single                        | One step for the selected agent                        |
| Sequential                    | One step per candidate, each depending on the previous |
| Parallel                      | Independent steps (no cross dependencies)              |
| Conditional                   | Branches on a confidence condition + else branch       |
| Hybrid                        | Sequential prefix → parallel middle → conditional tail |

The planner never invents routes: steps are derived only from the agents
present in `RouteDecision.candidates` / `selectedAgent`.

## Execution modes

- **SINGLE** — one execution step for the selected agent.
- **SEQUENTIAL** — ordered steps; step N depends on step N−1.
- **PARALLEL** — independent steps with no unresolved dependencies.
- **CONDITIONAL** — branches represented as declarative conditions.
- **HYBRID** — a mix; the plan stays acyclic and valid.

Modes are enabled via config feature flags
(`PLANNING_PARALLEL_ENABLED`, `PLANNING_CONDITIONAL_ENABLED`,
`PLANNING_HYBRID_ENABLED`). A disabled mode raises
`UnsupportedExecutionModeError`.

## Dependency graph

`buildDependencyGraph` validates:

- duplicate step IDs
- self dependencies
- missing dependencies (unknown step)
- invalid dependencies (empty ids)
- circular dependencies (via deterministic topological sort)

If a cycle exists, `ExecutionCycleError` is raised with the involved steps.
Depth and execution stages are computed deterministically.

## Conditions

`ExecutionCondition` operators: `EQUALS`, `NOT_EQUALS`, `GREATER_THAN`,
`LESS_THAN`, `EXISTS`, `NOT_EXISTS`, `MATCHES`, `AND`, `OR`, `NOT`.
Conditions are declarative data; they are never evaluated during planning.

## Policies

`ExecutionPolicy` / step `retry` carry timeout, retry count, retryable flag,
failure behavior (`FAIL_FAST`, `CONTINUE`, `FALLBACK`, `ESCALATE`),
continue/stop-on-failure, fallback-allowed, max steps and max total time.
These are planning metadata only.

## Optimization

`SafePlanOptimizer` applies only changes that cannot alter business meaning:

- removes exact duplicate steps
- removes unreachable steps
- removes dangling dependencies / empty branches
- merges identical condition metadata

Dependency ordering is always preserved.

## Validation

`validatePlanningRequest`, `validateRouteDecision`, `validateConstraints`
and `validatePlan` verify the route, primary/candidate agents, execution
mode, step/agent ids, dependencies, conditions, input/output references,
constraints, timeout/retry values and maximum step limits.

## Failure policies

`FailurePolicy`: `FAIL_FAST`, `CONTINUE`, `FALLBACK`, `ESCALATE`. The planner
only describes the policy; the future execution engine implements behaviour.

## Future execution engine integration

`ExecutionPlan` is declarative, versioned and re-runnable. A future execution
engine will consume `steps`, `dependencies`, `conditions` and `policy` to
actually run the agents. The planner never executes.

## Testing

Covered under `tests/unit/agents/ag-001-master-orchestrator/planning/`:
single/sequential/parallel/conditional/hybrid plans, route-to-plan
transformation, dependency validation (missing, duplicate, self, circular,
invalid), invalid agent/route/mode/condition, maximum steps/depth/parallel
branch limits, failure policies, input/output references, deterministic plan
generation, safe optimization (unreachable/duplicate step removal), config,
errors, and Sprint 1–4 contract compatibility.

## Examples

```ts
import { ExecutionPlanBuilder } from './index.js';
import { UserRole } from '../intent/index.js';

const builder = new ExecutionPlanBuilder();

const plan = builder.build({
  requestId: 'req-1',
  traceId: 'trace-1',
  request: { agentId: 'AG-101', type: 'route', payload: {}, context: {...} },
  intent: intentResult,   // Sprint 2 IntentResult
  context: snapshot,      // Sprint 3 ContextSnapshot
  route: routeDecision,   // Sprint 4 RouteDecision
  role: UserRole.Freelancer,
});

// plan.mode, plan.steps, plan.dependencies, plan.statistics, ...
```
