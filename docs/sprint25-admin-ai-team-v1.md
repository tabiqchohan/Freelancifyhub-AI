# Admin AI Team — Sprint 25 v1

## 1. Objective

Introduce the **Admin AI Team**: the fifth business agent team built on top of
the Sprint 19 Agent Platform, Sprint 20 coordination, the Sprint 18 agentic
loop and the AG-002/AG-003/AG-004 services. It serves AG-001 admin intents
(`admin.analytics`, `admin.fraud`, `admin.health`, `admin.aiops`,
`admin.executive`) plus `admin.action` (the pre-existing generic administrative
capability on AG-501) and direct deterministic capability tasks on all six
capability targets (catalog §14, exact ids AG-501..AG-505).

The team is the **highest-sensitivity business team**: deterministic-first,
data-honest and authorization-bounded. Every admin flow completes with the LLM
disabled and never fabricates metrics. Privileged writes are never executed —
sensitive/action requests are classified, approval-gated and only advised
(BR-ADM-2); fraud triage never auto-bans; AI-ecosystem changes are feature-flagged
and reversible (BR-ADM-4); the audit trail is safe and never leaks (BR-ADM-3);
every admin platform mirror ships v1 with an **empty tool allowlist** so tool and
agentic paths fail closed (BR-ADM-1).

## 2. Scope

In scope:

- `src/agents/admin-ai-team/` domain module: contract types (`types.ts`),
  constants (`constants.ts`), typed errors (`errors.ts`), bounded request
  schemas (`schemas.ts`), security/redaction utilities (`security.ts`),
  authorization / approval / audit helpers (`authorization.ts`),
  deterministic agents AG-501..AG-505 + the capability-aware dispatcher
  (`agents.ts`), context builder (`context.ts`), intent router (`router.ts`),
  workflow recipes (`workflows.ts`), tool/agentic integration (`tooling.ts`),
  event log (`events.ts`), metrics (`metrics.ts`), service (`service.ts`) and
  barrel (`index.ts`).
- Runtime agent slots AG-501..AG-505 (`createAdminTeamAgents`) registered in the
  runtime registry; platform mirrors registered in the platform registry with
  empty allowlists (fail closed).
- AG-001 additive admin intents (category Admin): `admin.analytics`,
  `admin.fraud`, `admin.health`, `admin.aiops`, `admin.executive` — registered in
  `intent/types.ts`, `intent/constants/keywords.ts`, `intent/registry/index.ts`
  and `routing/registry/index.ts` (routing capabilities: `analytics.query`,
  `fraud.monitor`, `platform.health`, `ai.ops`, `analytics.executive`).
- `ProductionComposition` wiring: `AdminContextBuilder`, `AdminTeamRouter`,
  `AdminWorkflowRegistry`, `AdminToolClient`, `AdminAIService`,
  `services.adminAi`, `health.probeAdminTeam`.
- `GET /healthz` `adminTeam` block + `GET /api/admin-ai/status`.
- Unit suite (98 tests) + integration suite (8 scenarios) +
  `platform-integration.test.ts` count updates (registered/ready 20 → 25).

Out of scope (deferred): real LLM executive synthesis (the agentic path is present
but fails closed with the v1 empty allowlist), durable persistence of admin
metrics/events, and any execution of privileged actions — the admin team only
advises and classifies, never writes (BR-ADM-2).

## 3. Architecture

```
               AdminRequest (validated by parseAdminRequest)
                                  │
                                  ▼
   ┌─────────────────── AdminAIService ────────────────────┐
   │  security.assertInputPayloadSafe → AdminContextBuilder│
   │  (AG-002 admin-group memory + AG-003 knowledge search,│
   │   bounded, degrade-to-warning, never user PII)        │
   │  → AdminTeamRouter (AG-001 intent / capability ⇒ route)│
   │     single ⇒ authorizeAdminRequest (BR-ADM-1)         │
   │             ⇒ AgentSelector pre-flight ⇒ runSingle    │
   │     workflow ⇒ authorizeAdminRequest ⇒                │
   │             AdminWorkflowRegistry ⇒ runWorkflow        │
   │  requiredTools ⇒ AdminToolClient → AG-004 (empty      │
   │                     allowlist ⇒ fail closed)          │
   │  agentic ⇒ runAdminAgenticTask → Sprint 18 loop       │
   │                     (reasoning + non-empty allowlist   │
   │                      required ⇒ fail closed w/ v1)     │
   │  finalize: sections + structuredData + recommendations │
   │            + stamped approval flags (BR-ADM-2) +       │
   │            safe audit events (BR-ADM-3) + honest        │
   │            insufficient-data metrics                   │
   └────────────────────────────────────────────────────────┘
                     │ agents driven via
                     ▼
             ProductionAgentExecutor
                 └──► AgentPlatformGateway (Sprint 19 gate + lease)
                              └──► CoordinationCoordinator (Sprint 20)
                                     └──► runtime agents / executors
```

The service returns an `AdminResult` for every request and never throws.

## 4. Deterministic agents (AG-501..AG-505)

| Agent              | Id       | Capabilities                      | Behaviour                                                                                                                                                                                                                                                           |
| ------------------ | -------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Analytics Agent    | `AG-501` | `admin.analytics`, `admin.action` | F21; interprets data questions into measure definitions, permitted-dataset checks and chart guidance; only supplied facts/queries are used and never fabricated. Status `InDevelopment`.                                                                            |
| Fraud Monitoring   | `AG-502` | `admin.fraud`                     | Triage of supplied fraud signals ONLY — never invents alerts; risk levels from supplied severity; SLA deadlines derived from `observedAt`; **no auto-ban ever** (`noAutoBans: true`, BR-ADM-2); high-risk triage raises `approvalRequired`. Status `InDevelopment`. |
| Platform Health    | `AG-503` | `admin.health`                    | Observed-SLO tracking from supplied metrics/topology only; `ok`/`warn`/`breach`/`n/a` thresholds and `degraded` flag; no metrics derived from nothing. Status `Draft`.                                                                                              |
| AI Operations      | `AG-504` | `admin.aiops`                     | Reviews proposed AI-ecosystem changes (feature-flag, canary, monitor, rollback-ready) that are reversible by default; approval required for any proposal; cost facts reported only; never applies a change (BR-ADM-4). Status `Draft`.                              |
| Executive Insights | `AG-505` | `admin.executive`                 | Summarizes supplied aggregated KPI facts only (`aggregatedOnly: true`, `piiFree: true`); anomalies flagged from note keywords; never invents platform totals. Status `Draft`.                                                                                       |

Capability-aware dispatch: agents read `admin.capability` from the execution
inputs and pick the analyzer for the requested capability when the agent
advertises it, else their primary capability — mirroring the freelancer,
marketplace and marketing dispatchers. All agents are cooperative to
cancellation (`admin.delayMs` is a bounded 0..5000 ms observability knob).
Platform dependencies: AG-502, AG-503, AG-504 and AG-505 depend on AG-501
(analytics); no admin-to-admin hard edges beyond that DAG.

## 5. Authorization, approvals & audit (BR-ADM-1..4)

- **BR-ADM-1 — fail closed:** every request authorizes on the mapped capability
  before any execution via `authorizeAdminRequest` (UNAUTHORIZED when the actor
  has no usable admin identity / no scopes; FORBIDDEN when the capability scope
  is missing). Scopes are fixed and never expandable: `users`, `projects`,
  `payments`, `disputes`, `fraud`, `ai`. Capability→scope map is a monotonic
  allow-list (`analytics`→users/projects/payments/disputes, `fraud`→fraud,
  `aiops`→ai, `action`/`health`/`executive`→all scopes).
- **BR-ADM-2 — approval gating:** mutable action kinds (`ban`, `suspend`,
  `refund`, `delete`, `config-change`, `feature-flag`, …) classify to
  `mutating`; `stampRecommendationApproval` marks any mutating recommendation and
  every `admin.aiops` proposal as `approvalRequired: true`. The AI only advises
  and never executes (`executed: false` everywhere in determinators).
- **BR-ADM-3 — safe audit:** typed `ADMIN_AUTHORIZATION_DENIED` /
  `ADMIN_CAPABILITY_DENIED` / `ADMIN_PRIVILEGED_ACTION_REQUESTED` events carry
  ids/statuses/reason codes only — never secrets, payloads or prompts.
- **BR-ADM-4 — reversible AI ops:** `admin.aiops` proposals are feature-flagged
  and reversible by default.

## 6. Contracts, validation & errors

- Request schema is **strict** (unknown keys rejected) and bounded: analytics
  query ≤ 2048 B, ≤ 20 fraud signals, ≤ 20 health metrics, ≤ 20 KPI facts,
  ≤ 8 scopes, ≤ 8 namespaces, ≤ 4 tool calls / required tools, namespace
  regex-capped, limits 1000..120000 ms.
- Exactly one of `intent` or `task` is required (`INVALID_INPUT` otherwise);
  capability tasks are refined against the 6-entry `ADMIN_CAPABILITY_TARGETS`.
- `metadata` is an open record — used for the test/observability
  `admin.delayMs` knob only.
- Cooperative cancellation is detached before validation and re-attached after.
- Error codes: `ADMIN_AI_INVALID_INPUT`, `ADMIN_AI_UNKNOWN_INTENT`,
  `ADMIN_AI_UNKNOWN_CAPABILITY`, `ADMIN_AI_UNAUTHORIZED`, `ADMIN_AI_FORBIDDEN`,
  `ADMIN_AI_PROMPT_INJECTION`, `ADMIN_AI_AGENT_REJECTED`,
  `ADMIN_AI_COORDINATION_FAILED`, `ADMIN_AI_COORDINATION_TIMEOUT`,
  `ADMIN_AI_CANCELLED`, `ADMIN_AI_INSUFFICIENT_DATA`,
  `ADMIN_AI_REASONING_UNAVAILABLE`, `ADMIN_AI_NO_RESPONSE`.

## 7. Security & boundaries

- Untrusted admin content is pre-flighted for cheap injection indicators
  (`PROMPT_INJECTION`); primary defense remains that deterministic agents never
  build prompts from admin text.
- The shared untrusted-context boundary token is neutralized and secret-shaped
  values (env vars, tokens, keys, credentials) are redacted before crossing the
  admin boundary; every value is bounded and responses are capped.
- Tools are gated twice: the router pre-flights `requiredTools` through the
  Sprint 20 `AgentSelector`, and `AdminToolClient` re-checks
  `gateway.isToolAllowed` + `toolManager.exists` before any I/O. Platform mirrors
  ship with an **empty allowlist** (fail closed by default), so every v1 tool
  request is denied. Agentic mode requires reasoning + non-empty allowlist and
  always fails closed with a typed error under the v1 configuration.
- Admin context retrieval never reads User-group memory; the ADMIN group reads
  admin-group memory and knowledge and degrades to a warning, never failing the
  request.
- Data honesty: `dataSufficient`/`insufficientData` reported per determinator;
  `hasInsufficientDataSignal` (recursive on output) feeds the
  `ADMIN_INSUFFICIENT_DATA` event + `insufficientData` metric; executive reports
  `aggregatedOnly` + `piiFree`.

## 8. Wiring (`composition-root.ts`, `runtime.ts`)

- Runtime registry: `createAdminTeamAgents()` (AG-501..AG-505).
- Platform registry: admin platform definitions registered activated with empty
  allowlists — platform-managed agents with every tool denied.
- Services: `adminContextBuilder`, `adminRouter`, `adminWorkflows`,
  `adminToolClient`, `adminAi` (built after coordination/executor/gateway).
- Health: `health.probeAdminTeam` wired into
  `defaultHealth(..., adminTeamInfo?)`; `HealthPayload.adminTeam` exposes
  `healthy / enabled / activeAgents / establishedAgents / workflows / eventCount`;
  the admin surface is `GET /api/admin-ai/status` plus the `/healthz` `adminTeam`
  block. Platform registry now reports 25 registered / 25 ready.

## 9. Observability

- Typed events: `ADMIN_WORKFLOW_SELECTED / STARTED / COMPLETED / FAILED /
CANCELLED / TIMEOUT`, `ADMIN_AGENT_STARTED / COMPLETED / FAILED / SKIPPED`,
  `ADMIN_AUTHORIZATION_DENIED`, `ADMIN_CAPABILITY_DENIED`, `ADMIN_TOOL_DENIED`,
  `ADMIN_RECOMMENDATION_GENERATED`, `ADMIN_PRIVILEGED_ACTION_REQUESTED`,
  `ADMIN_MEMORY_ACCESSED`, `ADMIN_KNOWLEDGE_ACCESSED`, `ADMIN_TOOL_USED`,
  `ADMIN_INSUFFICIENT_DATA`. Append-only, ordered, never carry secrets/payloads/
  prompts — only ids, statuses and reason codes (BR-ADM-3).
- Deterministic in-memory metrics snapshot: request/per-status counters, agent
  executions, tool calls/denials, authorization and capability denials,
  approval-required counts, coordination runs, agentic runs, insufficient-data
  counts, latency accumulator + averages.

## 10. Tests

- `tests/unit/agents/admin-ai-team/admin-ai-team.test.ts` (98): schemas (strict,
  bounded, one-of intent-or-task), security (boundary neutralization, secret
  redaction, injection indicators, prompt-injection rejection), errors, the full
  authorization matrix (BR-ADM-1 codes + approval stamping BR-ADM-2/4), all five
  determinators (including fraud no-auto-ban and executive aggregated-only),
  platform definitions (fail-closed empty allowlist), router (real
  `AgentSelector` + fakes, unknown intent/capability), the executive workflow
  recipe (Hybrid/BestEffort/AllResults/Collect fan-out), events and metrics.
- `tests/unit/app/admin-ai-integration.test.ts` (8): composition registration of
  all five agents + `adminAi` service, end-to-end HTTP routing (`admin.analytics`
  → AG-501), `/api/admin-ai/status` shape, UNAUTHORIZED and FORBIDDEN blocks via
  the service, a successful single analytics execution, insufficient-fraud
  `COMPLETED` with a no-data note, and an `INVALID_INPUT` for a request missing
  both intent and task.
- `platform-integration.test.ts` asserts the new platform counts (25 registered /
  25 ready), the admin capability/lifecycle surfaces (AG-501..AG-505), READY
  lifecycle state for AG-501/AG-505, fail-closed gateway behaviour, and the
  `/healthz` `adminTeam` block.

Gates: `tsc --noEmit`, `eslint .`, `prettier --check`, full `vitest run`
(174 files / 2140 tests), `npm run build` — all green.

## 11. Trade-offs & notes

- `admin.executive` is workflow-only: it never maps to a single capability, so
  the router resolves it to the executive-review workflow, which fans out three
  parallel capability-aware tasks (analytics AG-501, health AG-503, fraud AG-502)
  through `CoordinationMode.Hybrid`, `TaskFailurePolicy.BestEffort`,
  `ConflictPolicy.AllResults` and `AggregationStrategy.Collect`. The recipe is
  stored in `AdminWorkflowRegistry`; unknown workflow ids are rejected.
- Every admin platform mirror ships v1 with an empty allowlist by design — the
  same fail-closed default as the freelancer, marketplace and marketing teams.
  Prioritized writes, tool use and agentic execution stay gated until an operator
  explicitly enables them.
- Scoped authorization happens before execution and is re-enforced inside the
  workflow tasks (`admin.scopes` copied into each task so determinators can
  re-check BR-ADM-1 at the agent level).
- `structuredData` for single routes is keyed by the requested capability
  (`analytics`, `fraud`, `health`, `aiops`, `executive`, `action`) and for the
  executive workflow by task id (`analytics`, `health`, `fraud`) — mirroring the
  freelancer/marketplace/marketing teams' shape.
- All admin output is advisory: no ban, refund, config change or write is ever
  auto-executed; the AI classifies, gates approvals and reports honestly for a
  human admin to act on (BR-ADM-2).
