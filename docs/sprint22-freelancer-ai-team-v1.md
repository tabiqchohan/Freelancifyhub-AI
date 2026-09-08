# Freelancer AI Team — Sprint 22 v1

## 1. Objective

Introduce the **Freelancer AI Team**: the second business agent team built on top
of the Sprint 19 Agent Platform, Sprint 20 coordination, the Sprint 18 agentic
loop and the AG-002/AG-003/AG-004 services. It serves the AG-001 freelancer
intents (`profile.optimize`, `proposal.generate`, `project.match`,
`career.advice`) plus direct deterministic capability tasks
(`profile.analyze`, `proposal.draft`, `project.match`, `insight.analyze`).

The team is **deterministic-first**: every freelancer flow completes with the LLM
disabled. Values are either observed or explicitly labelled estimates (proposal
text is never fabricated — only user-provided drafts are echoed and structured
outlines are generated), match/score results are advisory only, freelancer
text/memory/knowledge are treated strictly as **data**, and every freelancer
platform mirror ships v1 with an **empty tool allowlist** so agentic/tool paths
fail closed until a tool is explicitly enabled.

## 2. Scope

In scope:

- `src/agents/freelancer-ai-team/` domain module: contract types (`types.ts`),
  constants (`constants.ts`), typed errors (`errors.ts`), bounded request schemas
  (`schemas.ts`), security/redaction utilities (`security.ts`), deterministic
  agents AG-201/AG-202/AG-206/AG-207 (`agents.ts`), context builder
  (`context.ts`), intent router (`router.ts`), workflow recipes (`workflows.ts`),
  tool/agentic integration (`tooling.ts`), event log (`events.ts`), metrics
  (`metrics.ts`), service (`service.ts`) and barrel (`index.ts`).
- Runtime agent slots AG-201/AG-202/AG-206/AG-207 (`createFreelancerTeamAgents`)
  registered in the runtime registry; platform mirrors
  (`createFreelancerTeamAgentDefinitions`, activated with an empty allowlist)
  registered in the platform registry.
- `ProductionComposition` wiring: `FreelancerContextBuilder`,
  `FreelancerTeamRouter`, `FreelancerWorkflowRegistry`, `FreelancerToolClient`,
  `FreelancerAIService`, `health.probeFreelancerTeam`.
- `GET /healthz` `freelancerTeam` block + `GET /api/freelancer-ai/status`.
- Unit suite (42 tests) + integration suite (16 scenarios) +
  `platform-integration.test.ts` count updates.

Out of scope (deferred): real LLM team generation (agentic path is present but
not required and fails closed with an empty allowlist), durable persistence of
freelancer metrics/events, multi-tenancy isolation beyond namespace-scoped
actors, and marketplace negotiation/quoting (AG-206 output is explicitly never a
commitment to hire).

## 3. Architecture

```
                 FreelancerRequest (validated by parseFreelancerRequest)
                                   │
                                   ▼
  ┌───────────────────── FreelancerAIService ─────────────────────┐
  │  security.assertInputPayloadSafe → FreelancerContextBuilder  │
  │  (AG-002 memory retrieve + AG-003 knowledge search, bounded) │
  │  → FreelancerTeamRouter (AG-001 intent / capability ⇒ route) │
  │     single ⇒ AgentSelector pre-flight ⇒ runSingle            │
  │     workflow ⇒ FreelancerWorkflowRegistry ⇒ runWorkflow      │
  │  requiredTools ⇒ FreelancerToolClient → AG-004 (empty        │
  │                     allowlist ⇒ fail closed)                 │
  │  agentic ⇒ runFreelancerAgenticTask → Sprint 18 loop (optional│
  │                     + empty allowlist ⇒ fail closed)         │
  │  finalize: sections + structuredData + recommendations + event│
  └────────────────────────────────────────────────────────────────┘
                     │ agents driven via
                     ▼
             ProductionAgentExecutor
                 └──► AgentPlatformGateway (Sprint 19 gate + lease)
                              └──► CoordinationCoordinator (Sprint 20)
                                     └──► runtime agents / executors
```

The service returns a `FreelancerResult` for every request and never throws.

## 4. Deterministic agents (AG-201/AG-202/AG-206/AG-207)

| Agent                  | Id       | Capability        | Behaviour                                                                                                                                                                                  |
| ---------------------- | -------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Proposal Writer        | `AG-201` | `proposal.draft`  | Echoes a user-provided draft verbatim (never fabricates text) and generates only a structured outline + alignment analysis against requirements. Status `InDevelopment`.                   |
| Profile Optimizer      | `AG-202` | `profile.analyze` | Assesses profile completeness (0..100 advisory) and normalizes declared skills against the shared catalog taxonomy (AC-06); skill ids are never invented. Status `Draft`.                  |
| Project Recommendation | `AG-206` | `project.match`   | Explainable fit score from `requiredSkills` + brief keyword hits vs the freelancer skill set; `advisoryOnly: true`, never a hire commitment. Status `InDevelopment`, category Marketplace. |
| Career Advisor         | `AG-207` | `insight.analyze` | Derives observable rates only (completion %, earnings/project); honest "insufficient data" guidance; no financial promises. Status `Draft`.                                                |

All four read structured inputs via `extractFreelancerInput` and are cooperative
to cancellation (`freelancer.delayMs` is a bounded 0..5000 ms observability
knob, never exposed to agent logic). AG-201 pipeline dependencies:
AG-206 + AG-202; AG-206 and AG-207 depend on AG-202.

## 5. Contracts, validation & errors

- Request schema is **strict** (unknown keys rejected) and bounded: draft ≤
  16 KiB, brief/bio ≤ 8192 B, ≤ 20 requirements, ≤ 40 skills, ≤ 4 tool calls /
  required tools, namespace regex-capped, experience ≤ 80 years, rating 0..5,
  activity counters clamped, limits 1000..120000 ms.
- Exactly one of `intent` or `task` is required (`INVALID_INPUT` otherwise); the
  schema recognises the four freelancer intents and the four capability ids.
- `metadata` is an open record — used for the test/observability
  `freelancer.delayMs` knob only; nothing else is consumed.
- Cooperative cancellation is detached before validation and re-attached after,
  so `AbortSignal`s never appear in serialized shapes.
- Error codes: `FREELANCER_AI_INVALID_INPUT`, `FREELANCER_AI_UNKNOWN_INTENT`,
  `FREELANCER_AI_UNKNOWN_CAPABILITY`, `FREELANCER_AI_UNAUTHORIZED`,
  `FREELANCER_AI_PROMPT_INJECTION`, `FREELANCER_AI_AGENT_REJECTED`,
  `FREELANCER_AI_COORDINATION_FAILED`, `FREELANCER_AI_COORDINATION_TIMEOUT`,
  `FREELANCER_AI_CANCELLED`, `FREELANCER_AI_INSUFFICIENT_DATA`,
  `FREELANCER_AI_NO_RESPONSE`.

## 6. Security & boundaries

- Unauthorized/risky content is rejected up front (`PROMPT_INJECTION`) using
  cheap deterministic injection indicators; the primary defense is that
  deterministic agents never build prompts from freelancer text.
- The shared untrusted-context boundary token is neutralized and secret-shaped
  values (env vars, tokens, keys, connection strings) are redacted before
  crossing the freelancer boundary; every value is bounded to 64 KiB and
  responses are capped at 4096 characters.
- Tools are gated twice: the router pre-flights `requiredTools` through the
  Sprint 20 `AgentSelector` (allowlist superset), and `FreelancerToolClient`
  re-checks `gateway.isToolAllowed` + `toolManager.exists` before any I/O.
  Platform mirrors ship with an **empty allowlist and `maxToolCalls: 0`**
  (fail-closed by default), so every tool request in v1 is denied.
- Agentic mode requires a working reasoning stack AND a non-empty tool
  allowlist; with the v1 empty allowlist it always fails closed with a typed
  error.
- Memory/knowledge retrieval goes through the acting freelancer's authorization
  scopes (Freelancer group) and degrades to a warning, never failing the request.

## 7. Wiring (`composition-root.ts`, `runtime.ts`)

- Runtime registry: `createFreelancerTeamAgents()` (AG-201/AG-202/AG-206/AG-207).
- Platform registry: `createFreelancerTeamAgentDefinitions()` registered with
  `activate: true` and empty allowlists — registered activated ⇒ platform-managed
  (`isPlatformManaged` true, `isToolAllowed` false).
- Services: `freelancerContextBuilder`, `freelancerRouter`,
  `freelancerWorkflows`, `freelancerToolClient`, `freelancerAi` (built after
  coordination services).
- Health: `health.probeFreelancerTeam` wired into
  `defaultHealth(..., freelancerTeamInfo?)`;
  `PlatformHealthPayload.freelancerTeam` exposes `healthy / enabled /
activeAgents / establishedAgents / workflows / eventCount`
  (established = the four freelancer-registered slots in the platform registry);
  the request surface is `GET /api/freelancer-ai/status` and the `/healthz`
  `freelancerTeam` block. Platform registry now reports 9 registered / 9 ready.

## 8. Observability

- Typed events: `FREELANCER_WORKFLOW_SELECTED / STARTED / COMPLETED / FAILED /
CANCELLED / TIMEOUT`, `FREELANCER_AGENT_STARTED / COMPLETED / FAILED /
SKIPPED`, `FREELANCER_RECOMMENDATION_GENERATED`, `FREELANCER_MEMORY_ACCESSED`,
  `FREELANCER_KNOWLEDGE_ACCESSED`, `FREELANCER_TOOL_USED`. Append-only, ordered,
  never carry secrets/payloads/prompts — only ids, statuses and reason codes.
- Deterministic in-memory metrics snapshot: request counters, per-status
  counters, agent executions, tool/failure counters, coordination calls,
  memory/knowledge retrieval counters, latency accumulator + averages.

## 9. Tests

- `tests/unit/agents/freelancer-ai-team/freelancer-ai-team.test.ts` (42):
  schemas, all deterministic agents, platform definitions (fail-closed empty
  allowlist), security/redaction, router (real `AgentSelector` + fakes), the
  proposal-draft workflow recipe, tool client + agentic fail-closed, events and
  metrics.
- `tests/unit/app/freelancer-ai-integration.test.ts` (16): single-agent
  profile/match/career runs, pipeline proposal workflow (profile → match →
  proposal), AG-002 memory context, AG-003 knowledge context, AG-004 tool
  denial against the empty allowlist, agentic → tool fail-closed, LLM-disabled
  fallback, paused-agent rejection, prompt-injection rejection, cancellation,
  timeout, coordination partial failure, concurrent workflows, and the
  `/healthz` + `/api/freelancer-ai/status` surfaces.
- `platform-integration.test.ts` asserts the new platform counts (9 registered /
  9 ready) and the freelancer lifecycle/tool/capability surfaces.

Gates: `tsc --noEmit`, `eslint`, `prettier --check`, full `vitest run`
(168 files / 1892 tests), `npm run build` — all green.

## 10. Trade-offs & notes

- Knowledge/memory in-memory engines match the full query phrase against
  key/title/content, so request context retrieval benefits from key/title
  overlap with the brief; worst case is empty context with a warning
  (deterministic agents still complete).
- Freelancer platform definitions ship v1 with an empty allowlist by design:
  agentic and tool-calling are fail-closed until an operator explicitly enables
  a tool; this is the opposite default from the client team (which enables
  `calculator`) and reflects the freelancer team's v1 deterministic-only scope.
- The agentic LLM path is intentionally optional; the deterministic surface is
  the product, and any future agentic run remains gated by composition-level
  reasoning availability AND a non-empty tool allowlist.
- Proposal text is never machine-written: only user drafts (echoed) and
  structured outlines (generated) — a deliberate honesty constraint for
  marketplace-facing content.
