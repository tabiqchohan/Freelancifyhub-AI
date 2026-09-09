# Marketing AI Team — Sprint 24 v1

## 1. Objective

Introduce the **Marketing AI Team**: the fourth business agent team built on top
of the Sprint 19 Agent Platform, Sprint 20 coordination, the Sprint 18 agentic
loop and the AG-002/AG-003/AG-004 services. It serves the AG-001 marketing
intent `marketing.campaign`, the five single marketing intents
(`marketing.research`, `marketing.social`, `marketing.blog`, `marketing.seo`,
`marketing.email`) plus direct deterministic capability tasks on the five
capability targets (`marketing.research`, `marketing.post.draft`,
`marketing.blog.draft`, `marketing.seo.analyze`, `marketing.email.draft`).

The team is **deterministic-first**: every marketing flow completes with the LLM
disabled. Output is draft-only and honest — no post or send is ever published
without a human gate (BR-AI-2, F20), research insights are reported only when a
source is cited and uncited claims are rejected (BR-AI-4), social/blog/email
copy never contains inflated promises or keyword stuffing and no ranking is ever
guaranteed (BR-AI-5), and every marketing platform mirror ships v1 with an
**empty tool allowlist** so agentic/tool paths fail closed until a tool is
explicitly enabled.

## 2. Scope

In scope:

- `src/agents/marketing-ai-team/` domain module: contract types (`types.ts`),
  constants (`constants.ts`), typed errors (`errors.ts`), bounded request
  schemas (`schemas.ts`), security/redaction utilities (`security.ts`),
  deterministic agents AG-401..AG-405 + the capability-aware dispatcher
  (`agents.ts`), context builder (`context.ts`), intent router (`router.ts`),
  workflow recipes (`workflows.ts`), tool/agentic integration (`tooling.ts`),
  event log (`events.ts`), metrics (`metrics.ts`), service (`service.ts`) and
  barrel (`index.ts`).
- Runtime agent slots AG-401..AG-405 (`createMarketingTeamAgents`) registered in
  the runtime registry; platform mirrors
  (`createMarketingTeamAgentDefinitions`, activated with an empty allowlist)
  registered in the platform registry.
- AG-001 additive marketing intents (`marketing.research`, `marketing.social`,
  `marketing.blog`, `marketing.seo`, `marketing.email`, `marketing.campaign`,
  category Marketing) — registered in `intent/types.ts`,
  `intent/constants/keywords.ts`, `intent/registry/index.ts` and
  `routing/registry/index.ts`.
- `ProductionComposition` wiring: `MarketingContextBuilder`,
  `MarketingTeamRouter`, `MarketingWorkflowRegistry`, `MarketingToolClient`,
  `MarketingAIService`, `health.probeMarketingTeam`.
- `GET /healthz` `marketingTeam` block + `GET /api/marketing-ai/status`.
- Unit suite (46 tests) + integration suite (19 scenarios) +
  `platform-integration.test.ts` count updates (registered/ready 15 → 20).

Out of scope (deferred): real LLM marketing copy generation (the agentic path is
present but fails closed with the v1 empty allowlist), durable persistence of
marketing metrics/events, publish/send execution (output is advisory drafts
only, never auto-published, BR-AI-2), and campaign execution beyond content
briefs (the campaign workflow produces research/social/email briefs, not sends).

## 3. Architecture

```
                MarketingRequest (validated by parseMarketingRequest)
                                   │
                                   ▼
  ┌────────────────── MarketingAIService ──────────────────┐
  │  security.assertInputPayloadSafe → MarketingContextBuilder│
  │  (AG-002 memory retrieve + AG-003 knowledge search,     │
  │   MARKETING actor groups, bounded, degrade-to-warning)  │
  │  → MarketingTeamRouter (AG-001 intent / capability ⇒ route)│
  │     single ⇒ AgentSelector pre-flight ⇒ runSingle       │
  │     workflow ⇒ MarketingWorkflowRegistry ⇒ runWorkflow   │
  │  requiredTools ⇒ MarketingToolClient → AG-004 (empty     │
  │                     allowlist ⇒ fail closed)            │
  │  agentic ⇒ runMarketingAgenticTask → Sprint 18 loop     │
  │                     (required: reasoning + non-empty     │
  │                      allowlist ⇒ fail closed w/ v1)      │
  │  finalize: sections + structuredData + recommendations + │
  │            events + honest insufficient-data metrics     │
  └─────────────────────────────────────────────────────────┘
                     │ agents driven via
                     ▼
             ProductionAgentExecutor
                 └──► AgentPlatformGateway (Sprint 19 gate + lease)
                              └──► CoordinationCoordinator (Sprint 20)
                                     └──► runtime agents / executors
```

The service returns a `MarketingResult` for every request and never throws.

## 4. Deterministic agents (AG-401..AG-405)

| Agent            | Id       | Capabilities            | Behaviour                                                                                                                                                                                                                                                              |
| ---------------- | -------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Research Agent   | `AG-401` | `marketing.research`    | Compiles cited insight summaries from provided sources only; claims without a source are rejected and reported honestly (`uncitedInsightsRejected: true`, BR-AI-4). Status `Draft`.                                                                                    |
| Social Media Mgr | `AG-402` | `marketing.post.draft`  | Structures a platform-bounded social variant (linkedin 3000, x 280, instagram 2200, facebook 5000 chars; caps variants at `MARKETING_MAX_SOCIAL_VARIANTS`); truncates archived copy rather than inventing; no engagement claims; `publishable: false`. Status `Draft`. |
| Blog Writer      | `AG-403` | `marketing.blog.draft`  | Produces an SEO-ready structural guide from topic + supplied copy; never invents an article body when no draft copy is supplied; flags overclaim phrases (BR-AI-5); `publishable: false`. Status `Draft`.                                                              |
| SEO Specialist   | `AG-404` | `marketing.seo.analyze` | On-page findings from the provided snapshot (title/meta/headings/body/keywords); flags keyword stuffing above 3% density (BR-AI-5); never guarantees or predicts ranking. Status `Draft`.                                                                              |
| Email Marketing  | `AG-405` | `marketing.email.draft` | Validates subject/body/CTA composition, honours opt-outs (`optOutRespected`), gates every send (`sendsGated: true`, F20), flags spam-risk signals; `publishable: false`. Status `Draft`.                                                                               |

Capability-aware dispatch: agents read `marketing.capability` from the execution
inputs and pick the analyzer for the requested capability when the agent
advertises it, else their primary capability — mirroring the freelancer and
marketplace dispatchers. All agents are cooperative to cancellation
(`marketing.delayMs` is a bounded 0..5000 ms observability knob). Platform
dependencies form a DAG with no marketing-to-marketing hard edges.

## 5. Contracts, validation & errors

- Request schema is **strict** (unknown keys rejected) and bounded: document
  fields ≤ 8192 B, ≤ 40 sources, ≤ 8 brand keywords, ≤ 40 headings, ≤ 4 tool
  calls / required tools, ≤ 4 workflow tasks per parallel fan-out, namespace
  regex-capped, limits 1000..120000 ms.
- Exactly one of `intent` or `task` is required (`INVALID_INPUT` otherwise);
  capability tasks are refined against the 5-capability
  `MARKETING_CAPABILITY_TARGETS`.
- `metadata` is an open record — used for the test/observability
  `marketing.delayMs` knob only.
- Cooperative cancellation is detached before validation and re-attached after,
  so `AbortSignal`s never appear in serialized shapes.
- Error codes: `MARKETING_AI_INVALID_INPUT`, `MARKETING_AI_UNKNOWN_INTENT`,
  `MARKETING_AI_UNKNOWN_CAPABILITY`, `MARKETING_AI_UNAUTHORIZED`,
  `MARKETING_AI_PROMPT_INJECTION`, `MARKETING_AI_AGENT_REJECTED`,
  `MARKETING_AI_COORDINATION_FAILED`, `MARKETING_AI_COORDINATION_TIMEOUT`,
  `MARKETING_AI_CANCELLED`, `MARKETING_AI_INSUFFICIENT_DATA`,
  `MARKETING_AI_NO_RESPONSE`.
- Platform budgets are centralized: `MARKETING_PLATFORM_BUDGETS` (linkedin 3000,
  x 280, instagram 2200, facebook 5000) and `MARKETING_MAX_SOCIAL_VARIANTS` (4).

## 6. Security & boundaries

- Unauthorized/risky content is rejected up front (`PROMPT_INJECTION`) using
  cheap deterministic injection indicators; the primary defense is that
  deterministic agents never build prompts from marketing text.
- The shared untrusted-context boundary token is neutralized and secret-shaped
  values (env vars, tokens, keys, connection strings) are redacted before
  crossing the marketing boundary; every value is bounded and responses are
  capped.
- Tools are gated twice: the router pre-flights `requiredTools` through the
  Sprint 20 `AgentSelector` (allowlist superset), and `MarketingToolClient`
  re-checks `gateway.isToolAllowed` + `toolManager.exists` before any I/O.
  Platform mirrors ship with an **empty allowlist and `maxToolCalls: 0`**
  (fail-closed by default), so every tool request in v1 is denied.
- Agentic mode requires a working reasoning stack AND a non-empty tool
  allowlist; with the v1 empty allowlist it always fails closed with a typed
  error.
- Memory/knowledge retrieval goes through the acting Marketing group's
  authorization scopes (the Marketing group reads short-term/project/workspace
  memory and reads knowledge; it cannot write to knowledge) and degrades to a
  warning, never failing the request.
- Data honesty: `hasInsufficientDataSignal` (recursive on the output) feeds the
  `MARKETING_INSUFFICIENT_DATA` event + `insufficientData` metric; research and
  blog/seo/email analyzers report `dataSufficient`/`draftComplete` honestly and
  never fabricate facts, metrics, promises or body copy.

## 7. Wiring (`composition-root.ts`, `runtime.ts`)

- Runtime registry: `createMarketingTeamAgents()` (AG-401..AG-405).
- Platform registry: `createMarketingTeamAgentDefinitions()` registered with
  `activate: true` and empty allowlists — registered activated ⇒ platform-managed
  (`isPlatformManaged` true, `isToolAllowed` false).
- Services: `marketingContextBuilder`, `marketingRouter`,
  `marketingWorkflows`, `marketingToolClient`, `marketingAi` (built after
  coordination services).
- Health: `health.probeMarketingTeam` wired into
  `defaultHealth(..., marketingTeamInfo?)`; `HealthPayload.marketingTeam` exposes
  `healthy / enabled / activeAgents / establishedAgents / workflows` (established
  = the five marketing-registered slots in the platform registry); the request
  surface is `GET /api/marketing-ai/status` and the `/healthz` `marketingTeam`
  block. Platform registry now reports 20 registered / 20 ready.

## 8. Observability

- Typed events: `MARKETING_WORKFLOW_SELECTED / STARTED / COMPLETED / FAILED /
CANCELLED / TIMEOUT`, `MARKETING_AGENT_STARTED / COMPLETED / FAILED / SKIPPED`,
  `MARKETING_RECOMMENDATION_GENERATED`, `MARKETING_MEMORY_ACCESSED`,
  `MARKETING_KNOWLEDGE_ACCESSED`, `MARKETING_TOOL_USED`,
  `MARKETING_INSUFFICIENT_DATA`. Append-only, ordered, never carry
  secrets/payloads/prompts — only ids, statuses and reason codes.
- Deterministic in-memory metrics snapshot: request counters, per-status
  counters, agent executions, tool/failure counters, coordination calls,
  insufficient-data counter, memory/knowledge retrieval counters, latency
  accumulator + averages.

## 9. Tests

- `tests/unit/agents/marketing-ai-team/marketing-ai-team.test.ts` (46):
  schemas (strict, bounded, one-of intent-or-task), all deterministic agents
  (research citation honesty, platform-bounded social variants, blog promise
  detection, SEO density maths, email opt-out/spam gating), platform definitions
  (fail-closed empty allowlist), security/redaction, router (real
  `AgentSelector` + fakes), the campaign workflow recipe, tool client + agentic
  fail-closed, events and metrics.
- `tests/unit/app/marketing-ai-integration.test.ts` (19): all five single
  capability targets, the `marketing.campaign` parallel fan-out
  (research/social/email via hybrid coordination), data-honesty
  `insufficientData` metrics, AG-002 memory context (Marketing actor group),
  AG-003 knowledge context, AG-004 tool denial against the empty allowlist,
  agentic → tool fail-closed, LLM-disabled fallback, paused-agent rejection,
  prompt-injection rejection, cancellation, timeout, coordination partial
  failure, concurrent workflows, and the `/healthz` + `/api/marketing-ai/status`
  surfaces.
- `platform-integration.test.ts` asserts the new platform counts (20 registered /
  20 ready), the five marketing lifecycle/capability surfaces, the READY
  lifecycle state for AG-401/AG-405, and fail-closed gateway behaviour for
  AG-401/AG-405.

Gates: `tsc --noEmit`, `eslint .`, `prettier --check` (new files formatted), full
`vitest run` (172 files / 2034 tests), `npm run build` — all green.

## 10. Trade-offs & notes

- `marketing.campaign` is workflow-only: it never maps to a single capability, so
  the router resolves it to the campaign workflow, which fans out three
  self-contained capability-aware tasks (research/social/email) through
  `CoordinationMode.Hybrid`, `TaskFailurePolicy.BestEffort`,
  `ConflictPolicy.AllResults` and `AggregationStrategy.Collect`. The recipe is
  stored in the `MarketingWorkflowRegistry` and enabled by default; unknown
  workflow ids are rejected. Blog and SEO are intentionally not part of the v1
  campaign fan-out (research feeds both, but blog/SEO drafts are single-capability
  requests in this sprint).
- Every marketing platform mirror ships v1 with an empty allowlist by design —
  the same fail-closed default as the freelancer and marketplace teams. Agentic
  and tool-calling remain gated until an operator explicitly enables a tool.
- In-memory memory retrieval matches the query against memory **keys**, so the
  integration tests seed memory keys that carry the marketing brief/topic text;
  knowledge search matches document titles/contents, and marketing platform
  mirrors only read (never write) knowledge.
- `structuredData` for single routes is keyed by capability (`research`, `social`,
  `blog`, `seo`, `email`) and for the campaign workflow by task id (`research`,
  `social`, `email`) — mirroring the freelancer/marketplace teams' shape.
- Social variants are bounded to their platform budget via `sanitizeMarketingText`
  (`truncateUtf8` to the platform's `budgetChars`); each variant reports
  `budgetChars`, `usedChars` and a `truncated` flag, and the draft is never
  invented — the engine preserves supplied copy, structures platform variants
  and leaves the copy itself to a human (BR-AI-2).
- All marketing output is advisory: research insights, SEO findings and
  social/blog/email drafts never auto-post, auto-send or guarantee outcomes
  (BR-AI-2, BR-AI-5, F18–F20).
