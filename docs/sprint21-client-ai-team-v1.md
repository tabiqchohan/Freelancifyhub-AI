# Client AI Team — Sprint 21 v1

## 1. Objective

Introduce the **Client AI Team**: the first business agent team built on top of the
Sprint 19 Agent Platform, Sprint 20 coordination, the Sprint 18 agentic loop and the
AG-002/AG-003/AG-004 services. It serves the AG-001 client intents
(`project.create`, `project.edit`, `project.view`, `project.delete`) plus direct
deterministic capability tasks (`budget.estimate`, `timeline.estimate`,
`skills.recommend`, `project.score`).

The team is **deterministic-first**: every client flow completes with the LLM
disabled. Estimated values are always labelled (never invented marketplace prices),
client text/memory/knowledge are treated strictly as **data**, tools run only through
AG-004 behind the platform tool allowlist, and misbehaving inputs fail closed.

## 2. Scope

In scope:

- `src/agents/client-ai-team/` domain module: contract types (`types.ts`), constants
  (`constants.ts`), typed errors (`errors.ts`), bounded request schemas
  (`schemas.ts`), security/redaction utilities (`security.ts`), deterministic agents
  AG-102..AG-105 (`agents.ts`), context builder (`context.ts`), intent router
  (`router.ts`), workflow recipes (`workflows.ts`), tool/agentic integration
  (`tooling.ts`), event log (`events.ts`), metrics (`metrics.ts`), service
  (`service.ts`) and barrel (`index.ts`).
- Runtime agent slots AG-102..AG-105 (`createClientTeamAgents`) registered in the
  runtime registry; platform mirrors (`createClientTeamAgentDefinitions`) registered
  in the platform registry (AG-101 is pre-registered by the runtime).
- `ProductionComposition` wiring: `ClientContextBuilder`, `ClientTeamRouter`,
  `ClientWorkflowRegistry`, `ClientToolClient`, `ClientAIService`,
  `health.probeClientTeam`.
- `GET /healthz` `clientTeam` block + `GET /api/client-ai/status`.
- Unit suite (34 tests) + integration suite (17 scenarios) +
  `platform-integration.test.ts` count updates.

Out of scope (deferred): real LLM team generation (agentic path is present but not
required), durable persistence of client metrics/events, multi-tenancy isolation
beyond namespace-scoped actors, and non-deterministic negotiation with freelancers.

## 3. Architecture

```
                  ClientRequest (validated by parseClientRequest)
                                   │
                                   ▼
  ┌──────────────────────── ClientAIService ────────────────────────┐
  │  security.assertInputPayloadSafe → ClientContextBuilder        │
  │  (AG-002 memory retrieve + AG-003 knowledge search, bounded)   │
  │  → ClientTeamRouter (AG-001 intent / capability ⇒ route)      │
  │     single ⇒ AgentSelector pre-flight ⇒ runSingle             │
  │     workflow ⇒ ClientWorkflowRegistry ⇒ runWorkflow           │
  │  requiredTools ⇒ ClientToolClient → AG-004 (allowlisted)      │
  │  agentic ⇒ runClientAgenticTask → Sprint 18 loop (optional)   │
  │  finalize: sections + structuredData + recommendations + event│
  └─────────────────────────────────────────────────────────────────┘
                     │ agents driven via
                     ▼
             ProductionAgentExecutor
                 └──► AgentPlatformGateway (Sprint 19 gate + lease)
                              └──► CoordinationCoordinator (Sprint 20)
                                     └──► runtime agents / executors
```

The service returns a `ClientResult` for every request and never throws.

## 4. Deterministic agents (AG-102..AG-105)

| Agent                 | Id       | Capabilities        | Behaviour                                                                                                                                                                                         |
| --------------------- | -------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Budget Estimator      | `AG-102` | `budget.estimate`   | Range from user budget or `hours × floor` (conservative $25/h floor, $50 minimum). Always `isEstimate: true`, `isQuote: false`, `currency: 'USD'`. Allowlists the `calculator` tool when enabled. |
| Timeline Estimator    | `AG-103` | `timeline.estimate` | Weeks range from user timeline or hours/40 per single-track week. `source: 'user'` vs `'calculated'`.                                                                                             |
| Skills Recommendation | `AG-104` | `skills.recommend`  | Fixed taxonomy only (catalog AC-06); suggested-skill ids never invented. Needs ≥2 keyword hits for "required".                                                                                    |
| Project Success Score | `AG-105` | `project.score`     | Advisory 0..100 completeness heuristic; `advisoryOnly: true`, never blocks publishing.                                                                                                            |

All four read structured inputs via `extractStructuredInput` and are cooperative to
cancellation signals (`client.delayMs` is a bounded observability knob never exposed
to agent logic).

## 5. Contracts, validation & errors

- Request schema is **strict** (unknown keys rejected) and bounded: brief ≤ 8192 B,
  ≤ 20 requirements, ≤ 40 skills, 4 max tool calls, budget/timeline ranges clamped,
  limits 1000..120000 ms.
- Exactly one of `intent` or `task` is required (`INVALID_INPUT` otherwise); the
  schema recognises the four project intents and the four capability ids.
- `metadata` is an open record — used for the test/observability `client.delayMs`
  knob only; nothing else is consumed.
- Cooperative cancellation is detached before validation and re-attached after, so
  `AbortSignal`s never appear in serialized shapes.
- Error codes: `CLIENT_AI_INVALID_INPUT`, `CLIENT_AI_PROMPT_INJECTION`,
  `CLIENT_AI_AGENT_REJECTED`, `CLIENT_AI_UNKNOWN_CAPABILITY`,
  `CLIENT_AI_COORDINATION_FAILED`, `CLIENT_AI_COORDINATION_TIMEOUT`,
  `CLIENT_AI_CANCELLED`, `CLIENT_AI_UNKNOWN_INTENT`.

## 6. Security & boundaries

- Unauthorized/risky content is rejected up front (`PROMPT_INJECTION`) using cheap
  deterministic injection indicators; the primary defense is that deterministic
  agents never build prompts from client text.
- A boundary token (`<untrusted_context>`) is neutralized and secret-shaped values
  are redacted before crossing the client boundary; every value is bounded to 64 KiB
  and responses are capped at 4096 characters.
- Tools are gated twice: the router pre-flights `requiredTools` through the Sprint 20
  `AgentSelector` (allowlist superset), and `ClientToolClient` re-checks
  `gateway.isToolAllowed` + `toolManager.exists` before any I/O. Default platform
  mirrors have an empty allowlist (`fail-closed`).
- Agentic mode requires a working reasoning stack and a non-empty tool allowlist;
  otherwise it fails closed with a typed error.
- Memory/knowledge retrieval goes through the acting client's authorization scopes
  (Client group) and degrades to a warning, never failing the request.

## 7. Wiring (`composition-root.ts`, `runtime.ts`)

- Runtime registry: `createClientTeamAgents()` (AG-102..AG-105).
- Platform registry: `createClientTeamAgentDefinitions({ toolsEnabled })` registered
  with `activate: true` (default tools enabled ⇒ AG-102 allows `calculator`).
- Services: `clientContextBuilder`, `clientRouter`, `clientWorkflows`,
  `clientToolClient`, `clientAi` (built after coordination services).
- Health: `health.probeClientTeam` wired into `defaultHealth(..., clientTeamInfo?)`;
  `PlatformHealthPayload.clientTeam` exposes `healthy / enabled / activeAgents /
establishedAgents / workflows / eventCount`; the request surface is
  `GET /api/client-ai/status` and the `/healthz` `clientTeam` block.

## 8. Observability

- Typed events: `CLIENT_AGENT_STARTED / COMPLETED / FAILED`, `CLIENT_TOOL_USED`,
  `CLIENT_WORKFLOW_STARTED / COMPLETED / PARTIAL / FAILED`,
  `CLIENT_RECOMMENDATION_GENERATED`, `CLIENT_ERROR`, `CLIENT_CANCELLED`,
  `CLIENT_TIMED_OUT`, `CLIENT_MEMORY_USED`, `CLIENT_KNOWLEDGE_USED`.
- Deterministic in-memory metrics snapshot: request counters, per-status counters,
  agent executions, tool/failure counters, latency accumulator + averages.

## 9. Tests

- `tests/unit/agents/client-ai-team/client-ai-team.test.ts` (34): schemas, all five
  deterministic functions, platform definitions (fail-closed default vs tools),
  security/redaction, router (real `AgentSelector` + fakes), workflow recipes, tool
  client + agentic fail-closed.
- `tests/unit/app/client-ai-integration.test.ts` (17): single budget estimate,
  sequential chaining, parallel project-creation workflow, AG-002 memory context,
  AG-003 knowledge context, AG-004 calculator tool, agentic → tool fail-closed,
  LLM-disabled fallback, mock-LLM typed result, paused-agent rejection,
  `TOOLS_ENABLED=false` denial, prompt-injection rejection, cancellation, timeout,
  coordination partial failure, concurrent workflows, and the `/healthz` +
  `/api/client-ai/status` surfaces.
- `platform-integration.test.ts` asserts the new platform counts (5 registered /
  5 ready) and the AG-102 lifecycle/tool/capability surfaces.

Gates: `tsc --noEmit`, `eslint`, `prettier --check`, full `vitest run`
(166 files / 1834 tests), `npm run build` — all green.

## 10. Trade-offs & notes

- Knowledge/memory in-memory engines match the full query phrase against
  key/title/content, so request context retrieval benefits from key/title overlap
  with the brief; worst case is empty context with a warning (deterministic agents
  still complete).
- The agentic LLM path is intentionally optional; the deterministic surface is the
  product, and agentic runs remain gated by composition-level reasoning availability.
- AG-101 ships as a runtime agent; this module only mirrors its client capabilities
  via established routes and does not re-register it.
