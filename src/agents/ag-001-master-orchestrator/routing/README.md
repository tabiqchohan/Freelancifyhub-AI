# AG-001 Routing Engine (Sprint 4)

Deterministic Agent Routing Engine for the Master Orchestrator.

## Purpose

Consumes an `AgentRequest` (Sprint 1), `IntentResult` (Sprint 2) and
`ContextSnapshot` (Sprint 3) and produces a validated `RouteDecision`:
which agent(s) are eligible, which agent is selected, why, with what
confidence, which fallbacks exist and whether the decision escalates.

## Responsibilities

- Candidate selection from the routing registry (intent + capability support).
- Deterministic scoring and ranking (config-driven weights, no randomness).
- Routing strategy resolution (DIRECT, CAPABILITY_MATCH, PRIORITY, FALLBACK, ESCALATION).
- Deterministic fallback handling with recorded reasons.
- Routing-level escalation metadata (no actual escalation execution).
- Confidence buckets (HIGH/MEDIUM/LOW) from spec §5 thresholds.
- Constraint enforcement (roles, capabilities, excluded agents, candidate limits, cost, min confidence).
- Structured, typed errors following AG-001 conventions.
- Logging of routing decisions (ids, intent, counts, strategy, confidence — never content).

## Non-responsibilities

- No agent execution.
- No execution planner (Sprint 5).
- No memory/knowledge retrieval, no tool execution, no LLM/API calls.
- No external communication, no business logic, no queueing, no load balancing.

## Architecture

```
routing/
  types/        shared types & enums (RoutingStatus, RoutingStrategy, ...)
  errors/       typed error hierarchy
  config/       zod-driven routing configuration (thresholds, weights, flags)
  interfaces/   contracts: registry, scorer, engine, RoutableAgent
  registry/     RoutingRegistry + default catalog adapter + intent→capability map
  matchers/     eligibility helpers (capability, status, constraints)
  scorers/      DeterministicRouteScorer
  strategies/   strategy/execution-mode resolution, candidate sorting/capping
  fallback/     deterministic fallback resolution
  escalations/  escalation metadata resolution
  validators/   request + constraints validation
  utils/        scoring weights helper, rounding
  index.ts      barrel
```

## Input

`RouteRequest`:

- `request` — `AgentRequest` (Sprint 1)
- `intent` — `IntentResult` (Sprint 2)
- `context` — `ContextSnapshot` (Sprint 3)
- `role` — `UserRole`
- `constraints?` — optional `RoutingConstraints`
- `requestId?`, `traceId?`

## Output

`RouteDecision`:

- `status` — `RoutingStatus` (Success / Fallback / Escalated / Failed)
- `strategy` — `RoutingStrategy`
- `executionMode` — `ExecutionMode` (for the Sprint 5 planner)
- `selectedAgent?` — `AgentRoute` (agent, score, confidence, strategy, reasons)
- `candidates` — ranked `RouteCandidate[]`
- `fallbacks` — `RouteFallback[]` (each records why it occurred)
- `escalation?` — `RouteEscalation` (reason + message + details)
- `confidence`, `confidenceLevel`, `confidenceThreshold`
- `reasons` — structured reasons for the decision
- `metadata` — version, routedAt, ids, counts, flags

## Candidate selection

1. Look up candidates via `RoutingRegistry.findCandidates(intentId)` which
   maps the intent to required capabilities.
2. An agent is eligible when it is a supported agent for the intent
   (`IntentDefinition.supportedAgents`) **or** it declares the required
   capability (enabled).
3. Constraint violations (excluded agents, required capability, allowed
   statuses) remove agents.
4. Availability does not disqualify — it lowers the score and can trigger
   fallback/escalation when the preferred agent is unavailable.

## Scoring

`DeterministicRouteScorer` computes a weighted total in [0,1]:

```
total = Σ weightᵢ · factorᵢ
```

| Factor                  | Weight (default) | Values                                  |
| ----------------------- | ---------------- | --------------------------------------- |
| intentMatch             | 0.30             | 1 if supported agent for the intent     |
| capabilityMatch         | 0.25             | 1 if the required capability is enabled |
| roleCompatibility       | 0.20             | 1 if role is allowed by the intent      |
| status                  | 0.10             | Production=1 … Retired=0                |
| priority                | 0.05             | Critical=1 … Low=0.4                    |
| cost                    | 0.03             | 1.0 (no cost metadata in Sprint 4)      |
| availability            | 0.03             | 1 available, 0 unavailable              |
| constraintCompatibility | 0.04             | 1 if no constraint violations           |

Weights must sum to 1 (enforced by config validation). Confidence = total
score. Confidence levels follow the orchestrator spec §5: High ≥ 0.80,
Medium 0.55–0.79, Low < 0.55.

## Routing strategies

- `DIRECT` — a single high-confidence intent→agent match.
- `CAPABILITY_MATCH` — multiple candidates, matched via capabilities.
- `PRIORITY` — candidates are ranked and the priority-driven ranking picks
  the winner.
- `FALLBACK` — the preferred agent was unavailable/excluded and a fallback
  was selected.
- `ESCALATION` — no routable agent / low confidence / permission denied.

## Fallback

When the preferred (highest-scoring) agent is unavailable or excluded:

1. The next-ranked available, non-excluded candidate is selected.
2. A `RouteFallback` entry records `originalAgentId`, `fallbackAgentId`,
   reason and confidence.
3. If no fallback exists, the decision escalates with
   `AGENT_UNAVAILABLE`. The engine never silently routes elsewhere.

## Escalation

`RouteEscalation` reasons: `NO_MATCH`, `LOW_CONFIDENCE`,
`PERMISSION_DENIED`, `AGENT_UNAVAILABLE`, `SYSTEM_CONSTRAINT`. Escalation
records structured information only; execution is out of scope.

## Confidence

- `confidence` — the score of the selected/primary candidate (0 when none).
- `confidenceLevel` — High/Medium/Low.
- `confidenceThreshold` — the low threshold used to accept a route.

## Determinism

Given the same request, intent, context, registry and configuration the
result is byte-for-byte identical (excluding the `routedAt` timestamp):

- No random selection.
- No time-dependent selection.
- Stable sorting (score desc, then agent id asc).
- Immutable inputs; no hidden mutable global state.

## Future Execution Planner integration

`RouteDecision` carries everything Sprint 5 needs to build a plan:

- selected agent + candidates (ranked)
- execution mode (`Single` / `Parallel` / `Sequential` / `Conditional` /
  `Hybrid`)
- fallbacks
- escalation metadata
- reasons and confidence

Sprint 5 will consume the decision; Sprint 4 does not execute anything.

## Testing

Covered under `tests/unit/agents/ag-001-master-orchestrator/routing/`:
direct intent match, capability match, multiple candidates, ranking,
priority, role compatibility, permission mismatch, disabled/unavailable
agent, no candidate, low confidence, fallback, escalation, excluded
agents, candidate limits, invalid intent/registry/config, deterministic
routing, multi-agent modes, error hierarchy, and Sprint 1/2/3 contract
compatibility.

## Examples

```ts
import { RoutingEngine } from './index.js';
import { UserRole } from '../intent/index.js';

const engine = new RoutingEngine();

const decision = engine.route({
  requestId: 'req-1',
  traceId: 'trace-1',
  request: { agentId: 'AG-001', type: 'route', payload: {}, context: {...} },
  intent: intentResult,          // Sprint 2 IntentResult
  context: snapshot,             // Sprint 3 ContextSnapshot
  role: UserRole.Freelancer,
});

// decision.status, decision.selectedAgent, decision.candidates, ...
```
