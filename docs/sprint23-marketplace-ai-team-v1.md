# Marketplace AI Team — Sprint 23 v1

## 1. Objective

Introduce the **Marketplace AI Team**: the third business agent team built on top
of the Sprint 19 Agent Platform, Sprint 20 coordination, the Sprint 18 agentic
loop and the AG-002/AG-003/AG-004 services. It serves the AG-001 marketplace
intent `engagement.scope`, the six single marketplace intents
(`contract.generate`, `milestone.plan`, `review.generate`, `scam.report`,
`dispute.open`, `message.send`), plus direct deterministic capability tasks
(including the secondary intelligence capabilities `project.quality`,
`opportunity.analyze`, `budget.analyze`, `marketplace.insights`,
`marketplace.discovery` — all 11 capability targets are dispatchable).

The team is **deterministic-first**: every marketplace flow completes with the
LLM disabled. Values are either observed or explicitly labelled estimates,
dataset-dependent features report `insufficientData` honestly (never invented
prices/trends), risk scores are advisory with no auto-actions, contract output
is a draft outline (never legal advice), reviews are never auto-posted, escrow
splits are enforced deterministically (BR-ESC-1), and every marketplace platform
mirror ships v1 with an **empty tool allowlist** so agentic/tool paths fail
closed until a tool is explicitly enabled.

## 2. Scope

In scope:

- `src/agents/marketplace-ai-team/` domain module: contract types (`types.ts`),
  constants (`constants.ts`), typed errors (`errors.ts`), bounded request
  schemas (`schemas.ts`), security/redaction utilities (`security.ts`),
  deterministic agents AG-301..AG-306 + the capability-aware dispatcher
  (`agents.ts`), context builder (`context.ts`), intent router (`router.ts`),
  workflow recipes (`workflows.ts`), tool/agentic integration (`tooling.ts`),
  event log (`events.ts`), metrics (`metrics.ts`), service (`service.ts`) and
  barrel (`index.ts`).
- Runtime agent slots AG-301..AG-306 (`createMarketplaceTeamAgents`) registered
  in the runtime registry; platform mirrors
  (`createMarketplaceTeamAgentDefinitions`, activated with an empty allowlist)
  registered in the platform registry.
- AG-001 additive `ENGAGEMENT_SCOPE` intent (`engagement.scope`, category
  Contracts, priority Medium, roles Client+Freelancer, confidence threshold
  0.55, hosted on AG-301/AG-302) — registered in `intent/types.ts`,
  `intent/constants/keywords.ts`, `intent/registry/index.ts` and
  `routing/registry/index.ts`.
- `ProductionComposition` wiring: `MarketplaceContextBuilder`,
  `MarketplaceTeamRouter`, `MarketplaceWorkflowRegistry`, `MarketplaceToolClient`,
  `MarketplaceAIService`, `health.probeMarketplaceTeam`.
- `GET /healthz` `marketplaceTeam` block + `GET /api/marketplace-ai/status`.
- Unit suite (52 tests) + integration suite (25 scenarios) +
  `platform-integration.test.ts` count updates (registered/ready 9 → 15).

Out of scope (deferred): real LLM marketplace generation (the agentic path is
present but fails closed with the v1 empty allowlist), durable persistence of
marketplace metrics/events, marketplace payments execution (output is advisory:
escrow plans and draft outlines, never executions), and legal auto-signing
(contracts are outlines only, never legal advice).

## 3. Architecture

```
                 MarketplaceRequest (validated by parseMarketplaceRequest)
                                   │
                                   ▼
  ┌────────────────── MarketplaceAIService ───────────────────┐
  │  security.assertInputPayloadSafe → MarketplaceContextBuilder │
  │  (AG-002 memory retrieve + AG-003 knowledge search, bounded) │
  │  → MarketplaceTeamRouter (AG-001 intent / capability ⇒ route) │
  │     single ⇒ AgentSelector pre-flight ⇒ runSingle            │
  │     workflow ⇒ MarketplaceWorkflowRegistry ⇒ runWorkflow      │
  │  requiredTools ⇒ MarketplaceToolClient → AG-004 (empty        │
  │                     allowlist ⇒ fail closed)                 │
  │  agentic ⇒ runMarketplaceAgenticTask → Sprint 18 loop (optional│
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

The service returns a `MarketplaceResult` for every request and never throws.

## 4. Deterministic agents (AG-301..AG-306)

| Agent               | Id       | Capabilities                                                   | Behaviour                                                                                                                                                                                                                                |
| ------------------- | -------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contract Generator  | `AG-301` | `contract.generate`, `project.quality`, `opportunity.analyze`  | Drafts milestone-based contract outlines from agreed terms; blocks on missing mandatory terms (client/freelancer party, payment terms, milestones). Outline only — never legal advice. Depends on AG-302. Status `Draft`.                |
| Milestone Planner   | `AG-302` | `milestone.plan`, `budget.analyze`                             | Proposes/validates milestone splits enforced against the budget (BR-ESC-1); sum must equal budget to be escrow-compliant. Status `Draft`.                                                                                                |
| Review Generator    | `AG-303` | `review.generate`                                              | Drafts neutral review outlines from observed engagement facts; no facts ⇒ "insufficient data", nothing invented; retaliation language flagged for human moderation. Status `Draft`.                                                      |
| Scam Detection      | `AG-304` | `scam.report`, `marketplace.insights`, `marketplace.discovery` | Weighted risk score from observed signals only (payment/contact off-platform 30, urgency/suspicious link 15, new/reported account 10); no auto-actions. Insights/discovery report only observed dataset signals. Status `InDevelopment`. |
| Dispute Assistant   | `AG-305` | `dispute.open`                                                 | Bounded case summary + evidence pack; `humanDecides: true`, recommendation only (BR-DIS-3). Depends on AG-303 + AG-301. Status `Draft`.                                                                                                  |
| Messaging Assistant | `AG-306` | `message.send`                                                 | Deterministic policy screening (payment-off-platform ⇒ block, contact-off-platform ⇒ hold, else allow); never impersonates the user. Depends on AG-304. Status `InDevelopment`.                                                          |

Capability-aware dispatch: agents read `marketplace.capability` from the execution
inputs and pick the analyzer for the requested capability when the agent
advertises it, else their primary capability — so secondary intelligence
capabilities (`project.quality` on AG-301, `budget.analyze` on AG-302,
`marketplace.insights`/`marketplace.discovery` on AG-304) route to their host
agent. All agents are cooperative to cancellation (`marketplace.delayMs` is a
bounded 0..5000 ms observability knob). Platform dependencies form a DAG:
AG-306 → AG-304, AG-305 → AG-303/AG-301, AG-301 → AG-302; AG-304's catalog
data-edge to AG-306 is an event-stream output, not a hard dependency (keeps the
registry acyclic).

## 5. Contracts, validation & errors

- Request schema is **strict** (unknown keys rejected) and bounded: document
  fields ≤ 8192 B, ≤ 80 skills, ≤ 40 requirements, ≤ 12 milestones, ≤ 10 terms,
  payments ≤ 1000000000, message body ≤ document cap, ≤ 4 tool calls / required
  tools, namespace regex-capped, limits 1000..120000 ms.
- Exactly one of `intent` or `task` is required (`INVALID_INPUT` otherwise);
  capability tasks are refined against the 11-capability `MARKETPLACE_CAPABILITY_TARGETS`.
- `metadata` is an open record — used for the test/observability
  `marketplace.delayMs` knob only.
- Cooperative cancellation is detached before validation and re-attached after,
  so `AbortSignal`s never appear in serialized shapes.
- Error codes: `MARKETPLACE_AI_INVALID_INPUT`, `MARKETPLACE_AI_UNKNOWN_INTENT`,
  `MARKETPLACE_AI_UNKNOWN_CAPABILITY`, `MARKETPLACE_AI_UNAUTHORIZED`,
  `MARKETPLACE_AI_PROMPT_INJECTION`, `MARKETPLACE_AI_AGENT_REJECTED`,
  `MARKETPLACE_AI_COORDINATION_FAILED`, `MARKETPLACE_AI_COORDINATION_TIMEOUT`,
  `MARKETPLACE_AI_CANCELLED`, `MARKETPLACE_AI_INSUFFICIENT_DATA`,
  `MARKETPLACE_AI_NO_RESPONSE`.

## 6. Security & boundaries

- Unauthorized/risky content is rejected up front (`PROMPT_INJECTION`) using
  cheap deterministic injection indicators; the primary defense is that
  deterministic agents never build prompts from marketplace text.
- The shared untrusted-context boundary token is neutralized and secret-shaped
  values (env vars, tokens, keys, connection strings) are redacted before
  crossing the marketplace boundary; every value is bounded and responses are
  capped.
- Tools are gated twice: the router pre-flights `requiredTools` through the
  Sprint 20 `AgentSelector` (allowlist superset), and `MarketplaceToolClient`
  re-checks `gateway.isToolAllowed` + `toolManager.exists` before any I/O.
  Platform mirrors ship with an **empty allowlist and `maxToolCalls: 0`**
  (fail-closed by default), so every tool request in v1 is denied.
- Agentic mode requires a working reasoning stack AND a non-empty tool
  allowlist; with the v1 empty allowlist it always fails closed with a typed
  error.
- Memory/knowledge retrieval goes through the acting Marketplace group's
  authorization scopes and degrades to a warning, never failing the request.
- Data honesty: `hasInsufficientDataSignal` (recursive on the output) feeds the
  `MARKETPLACE_INSUFFICIENT_DATA` event + `insufficientData` metric; `budget`
  reports `marketRate: 'unavailable'` unless a provided budget range allows a
  computed observation — never a claimed market rate.

## 7. Wiring (`composition-root.ts`, `runtime.ts`)

- Runtime registry: `createMarketplaceTeamAgents()` (AG-301..AG-306).
- Platform registry: `createMarketplaceTeamAgentDefinitions()` registered with
  `activate: true` and empty allowlists — registered activated ⇒ platform-managed
  (`isPlatformManaged` true, `isToolAllowed` false).
- Services: `marketplaceContextBuilder`, `marketplaceRouter`,
  `marketplaceWorkflows`, `marketplaceToolClient`, `marketplaceAi` (built after
  coordination services).
- Health: `health.probeMarketplaceTeam` wired into
  `defaultHealth(..., marketplaceTeamInfo?)`;
  `PlatformHealthPayload.marketplaceTeam` exposes
  `healthy / enabled / activeAgents / establishedAgents / workflows / eventCount`
  (established = the six marketplace-registered slots in the platform registry);
  the request surface is `GET /api/marketplace-ai/status` and the `/healthz`
  `marketplaceTeam` block. Platform registry now reports 15 registered / 15 ready.

## 8. Observability

- Typed events: `MARKETPLACE_WORKFLOW_SELECTED / STARTED / COMPLETED / FAILED /
CANCELLED / TIMEOUT`, `MARKETPLACE_AGENT_STARTED / COMPLETED / FAILED /
SKIPPED`, `MARKETPLACE_RECOMMENDATION_GENERATED`, `MARKETPLACE_MEMORY_ACCESSED`,
  `MARKETPLACE_KNOWLEDGE_ACCESSED`, `MARKETPLACE_TOOL_USED`,
  `MARKETPLACE_INSUFFICIENT_DATA`. Append-only, ordered, never carry
  secrets/payloads/prompts — only ids, statuses and reason codes.
- Deterministic in-memory metrics snapshot: request counters, per-status
  counters, agent executions, tool/failure counters, coordination calls,
  insufficient-data counter, memory/knowledge retrieval counters, latency
  accumulator + averages.

## 9. Tests

- `tests/unit/agents/marketplace-ai-team/marketplace-ai-team.test.ts` (52):
  schemas, all deterministic agents, platform definitions (fail-closed empty
  allowlist), security/redaction, router (real `AgentSelector` + fakes),
  the engagement-scope workflow recipe, tool client + agentic fail-closed,
  events and metrics.
- `tests/unit/app/marketplace-ai-integration.test.ts` (25): all 11 capability
  targets (including secondary `project.quality`, `budget.analyze`,
  `marketplace.insights`, `marketplace.discovery`), the engagement.scope
  parallel fan-out (risk/milestones/contract via hybrid coordination),
  insufficient-data metric honesty, AG-002 memory context, AG-003 knowledge
  context, AG-004 tool denial against the empty allowlist, agentic → tool
  fail-closed, LLM-disabled fallback, paused-agent rejection, prompt-injection
  rejection, cancellation, timeout, coordination partial failure, concurrent
  workflows, and the `/healthz` + `/api/marketplace-ai/status` surfaces.
- `platform-integration.test.ts` asserts the new platform counts (15 registered /
  15 ready), the six lifecycle/capability/tool surfaces, the AG-304 `InDevelopment`
  lifecycle state, and fail-closed gateway behaviour for AG-301/AG-304.

Gates: `tsc --noEmit`, `eslint`, `prettier --check` (new files formatted), full
`vitest run` (170 files / 1969 tests), `npm run build` — all green.

## 10. Trade-offs & notes

- `engagement.scope` is workflow-only: it never maps to a single capability, so
  the router resolves it to the engagement-scope workflow, which fans out three
  self-contained capability-aware tasks (risk/milestones/contract) through
  `CoordinationMode.Hybrid`, `BestEffort`, `AllResults` aggregation. All three
  task recipes are stored in the `MarketplaceWorkflowRegistry` and enabled by
  default; unknown workflow ids are rejected.
- Every marketplace platform mirror ships v1 with an empty allowlist by design —
  the same fail-closed default as the freelancer team. Agentic and tool-calling
  remain gated until an operator explicitly enables a tool.
- The catalog (§12) lists AG-304 → AG-306 and AG-306 → AG-304 data flows. The
  platform registry is a DAG, so AG-306's edge (AG-306 → AG-304) is modelled as
  the hard dependency and AG-304's catalog edge is emitted as an event-stream
  output (flag signals), keeping registration acyclic.
- `structuredData` for single routes is keyed by capability (`contract`, `quality`,
  `milestones`, `budget`, `review`, `risk`, `insights`, `discovery`, `dispute`,
  `message`) and for workflows by task id (`risk`, `milestones`, `contract`) —
  mirroring the freelancer team's ergonomic shape.
- Risk scores, review ratings, opportunity/milestone/discovery outputs and
  dispute summaries are advisory: no automatic action (payment, posting,
  resolution) is ever executed outside the deterministic planner.
