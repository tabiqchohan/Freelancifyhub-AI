# Production AI Operating System — Sprint 26 v1

## 1. Objective

Introduce the **AI Operating System (AIOS)**, a thin, fail-closed operating
layer on top of everything shipped through Sprint 19-25: the AG-001 master
orchestrator, the five AI teams (client Sprint 21, freelancer Sprint 22,
marketplace Sprint 23, marketing Sprint 24, admin Sprint 25), the AG-002
memory layer, AG-003 knowledge and the runtime/agent registries. One public
surface — `POST /api/ai/request` — accepts natural-language requests and runs
them through a deterministic **13-stage pipeline** whose classification uses
the SAME `RuleBasedIntentClassifier` as AG-001 and whose dispatch is derived
from AG-001's own intent-registry data (category + supported agents), never a
second routing table.

Every value crossing the AIOS boundary is typed, bounded and secret-free; the
AIOS never replaces, redesigns or duplicates an existing agent path — it
provisions context, authorizes at a coarse capability level and executes
through the owning team service (or AG-001's orchestrator tail for platform
intents). Control-plane knobs (delay/latency, task timeout, global deadline,
cancel) make the PARTIAL / TIMED_OUT / CANCELLED contract **deterministic and
testable** end-to-end.

## 2. Scope

In scope:

- `src/ai-operating-system/` domain module: contracts (`types.ts`), fail-closed
  config (`config.ts`), typed errors + stable HTTP mapping (`errors.ts`),
  schema-bounded input validation (`schemas.ts`), secret/injection pre-flight
  (`security.ts`), request context + route derivation (`request-context.ts`),
  coarse authorization (`policy.ts`), the 13-stage pipeline (`pipeline.ts`),
  the execution service / orchestrator tail (`service.ts`), result/response
  normalization (`execution-result.ts`, `response.ts`), idempotency
  (`idempotency.ts`), events (`events.ts`), metrics (`metrics.ts`), the public
  gateway (`gateway.ts`) and barrel (`index.ts`).
- A deterministic **AG-003 Knowledge Manager runtime agent**
  (`src/agents/runtime/knowledge-runtime-agent.ts`, capabilities
  `knowledge.search` / `knowledge.answer`) registered in the runtime registry
  and platform registry, filling the orchestrator-tail execution slot for
  platform-level intents.
- The **delay-knob merge** in all five team workflow registries
  (`src/agents/{client,freelancer,marketplace,marketing,admin}-ai-team/
workflows.ts`): `sharedInput` now carries `{ '<team>.delayMs': <n> }` when
  the AIOS metadata knob is present, so latency is honoured on the workflow
  path too (not just single-capability tasks).
- Env wiring (`src/app/env.ts` `aios` config), composition wiring
  (`services.aios`, `health.probeAios`), runtime routes
  (`/api/ai/request`, `/api/ai/status`, `/api/ai/cancel`) and the `/health`
  `aiOperatingSystem` block.
- Integration suite (18 scenarios) + AIOS unit suites + new unit suites for
  the AG-003 agent and the workflow delay-knob merge.
- `docs/sprint26-production-ai-operating-system-v1.md` (this document).

Out of scope (deferred): real LLM synthesis inside the AIOS layer (the AIOS is
deterministic by design; any reasoning goes through the existing Sprint 17/18
layers), durable persistence of AIOS events/metrics, and any new routing table.

## 3. Architecture

The AIOS is a **13-stage fail-closed pipeline** wrapped by a public gateway:

```
 POST /api/ai/request  (schema-bounded body)
        │
        ▼
 AiosGateway
   ├─ idempotency claim / replay / conflict (AIOS_IDEMPOTENCY_WINDOW_MS)
   └─► AiosPipeline (13 stages, order fixed below)
        │
        ▼
 AiosService  ── tail dispatch ──►  owning team service (client/freelancer/
        │                            marketplace/marketing/admin) OR the
        │                            AG-001 MasterOrchestratorService
        ▼
 AiosEventLog (ring buffer + runtime event bridge forward)
 AiosMetrics  (request/status counters, latency)
        ▼
 AiosResponse / AiosError  (bounded, typed, never leaks internals)
```

Stages (exact vocabulary in `AiosStage`, surfaced verbatim on
`AiosResponse.stages`):

1. `VALIDATE` — schema-bounded input check.
2. `CREATE_REQUEST_CONTEXT` — materialise a bounded request/trace context.
3. `DETECT_INTENT` — AG-001 `RuleBasedIntentClassifier` (single classifier).
4. `BUILD_CONTEXT` — provision AG-002 memory context through the request-actor
   registry (namespaces fail-closed when empty).
5. `AUTHORIZE` — coarse capability policy (`admin.`/`system.` need an Admin
   actor; Guests only reach platform-level intents).
6. `ROUTE` — derive the execution target from AG-001 registry data:
   category Help/Knowledge/System ⇒ orchestrator tail; otherwise the team of
   the intent's first supported agent id (AG-5⇒admin, AG-1⇒client, AG-2⇒
   freelancer, AG-3⇒marketplace, AG-4⇒marketing).
7. `PLAN` — single-step plan around the resolved tail.
8. `EXECUTE` — run the tail (team service via `ProductionAgentExecutor`, or
   the orchestrator for platform intents); honours timeout/cancel.
9. `AGGREGATE` — normalize team/orchestrator results into one bounded result.
10. `SAFETY_CHECK` — final secret/injection re-check on the assembled output.
11. `PERSIST_EVENTS` — AIOS events logged + forwarded onto the AG-002 runtime
    event bridge.
12. `UPDATE_METRICS` — request/status counters updated.
13. `FINALIZE_RESPONSE` — produce the final safe `AiosResponse`.

Terminal statuses reuse the AG-001 aggregation vocabulary (`SUCCESS`, `PARTIAL`,
`TIMED_OUT`, `CANCELLED`, …); the whole pipeline fails closed on any unhandled
error with a typed `AiosError`.

## 4. Configuration & contracts

Fail-closed config in `config.ts` (`parseAiosConfig`, invalid env aborts
construction) — all typed and bounded, consumed only at the AIOS boundary:

| Key                                | Default | Meaning                                 |
| ---------------------------------- | ------- | --------------------------------------- |
| `AIOS_MAX_TEXT_LENGTH`             | 20000   | Hard ceiling on inbound `text` length   |
| `AIOS_STRUCTURED_DEPTH`            | 6       | Max depth of structured input JSON      |
| `AIOS_STRUCTURED_MAX_BYTES`        | 131072  | Max serialised structured size          |
| `AIOS_REQUEST_TIMEOUT_MS`          | 60000   | Per-request execution timeout           |
| `AIOS_SECRET_SCAN_ENABLED`         | true    | Inbound secret scanning at the boundary |
| `AIOS_EVENT_WINDOW`                | 200     | Recent AIOS events retained in the ring |
| `AIOS_IDEMPOTENCY_WINDOW_MS`       | 300000  | Idempotency-key dedup window            |
| `AIOS_STRUCTURED_HARD_LIMIT_BYTES` | 262144  | Absolute structured ceiling (hard-fail) |

Request body at `POST /api/ai/request`: `requestId`, `traceId`, `text`,
`structured`, `role`, `actorId`, `actorGroup`, `namespaces` (fail-closed when
empty), `adminScopes`, `securityClearance`, `idempotencyKey`, `timeoutMs`,
`metadata`. Defaults: `role` ⇒ Freelancer, `actorId` ⇒ `aios-gateway`, traceId
derived. `text` empty/whitespace ⇒ 400 `text_required`.

Error contract (`AIOS_ERROR_HTTP_STATUS` in `errors.ts`, mapped by
`toAiosError` and rendered by `sendAiosError`): `AIOS_UNKNOWN_INTENT` ⇒ 422,
`AIOS_SECRET_DETECTED` ⇒ 400, `AIOS_PAYLOAD_TOO_LARGE` ⇒ 413,
`AIOS_UNAUTHORIZED_SCOPE` ⇒ 403, `AIOS_IDEMPOTENCY_CONFLICT` ⇒ 409,
deadline ⇒ 504, cancelled ⇒ 499, internal ⇒ 500; invalid input ⇒ 400.

## 5. Idempotency, timeouts & cancellation

- **Idempotency** (`idempotency.ts` + gateway claim): the same
  `idempotencyKey` + request within the window replies with the cached
  `AiosResponse` (`replay`); a different concurrent request claiming the same
  key raises `AIOS_IDEMPOTENCY_CONFLICT` (409).
- **Per-request timeout**: `timeoutMs` (normalized, bounded); the AIOS global
  deadline wins the race against team internal deadlines and returns
  `TIMED_OUT` (`/deadline/i` response message).
- **Cancellation**: `POST /api/ai/cancel` delivers a cooperative abort to the
  in-flight tail (team coordination forwards `request.cancellation?.signal`
  into the coordination request; the coordinator observes the abort signal
  mid-flight). A cancelled request returns `CANCELLED` and is reflected in
  `statusCounts`.
- **Deterministic scenarios** (see integration suite §10): the client
  `project.create` default workflow is driven through the delay knob
  (`aios.delayMs` ⇒ `<team>.delayMs` merged into the workflow `sharedInput`, so
  the runtime agents' `cancellableDelay` actually sleeps on the workflow path):
  - `delayMs: 5000, taskTimeoutMs: 1000` ⇒ `PARTIAL` (coordination reports a
    timeout with zero failures ⇒ Partial under BestEffort).
  - `delayMs: 5000, timeoutMs: 150` ⇒ `TIMED_OUT` (AIOS global deadline wins).
  - `delayMs: 5000` + gateway `cancel` after ~300 ms ⇒ `CANCELLED`.

## 6. Orchestrator tail & deterministic AG-003

Platform-level intents (category Help/Knowledge/System — e.g.
`knowledge.search`, `platform.help`) run through the AG-001
`MasterOrchestratorService`. That tail executes the new **deterministic
AG-003 "Knowledge Manager" runtime agent**,
`src/agents/runtime/knowledge-runtime-agent.ts`:

- Capabilities `knowledge.search` / `knowledge.answer`, category Core, depends
  on AG-001 (required), version 1.0.0.
- Registered in the runtime `AgentRegistry` (so `ProductionAgentExecutor.can
Execute` resolves it) and mirrored in the platform registry with
  `activate: true` right after the AG-101 mirror.
- Reads `request.input` / `input`, honours the same bounded knobs as the other
  runtime agents: `runtime.delayMs` (0-5000 clamp via `cancellableDelay`),
  `runtime.fail` ⇒ `KNOWLEDGE_AGENT_FAILURE`, and cooperative cancellation ⇒
  `EXECUTION_CANCELLED`.
- Output `{ answer: { text, confidence, citations }, agent, memory }`; empty
  query ⇒ no citations and confidence 0 — knowledge is never fabricated.

## 7. Wiring

- `src/app/env.ts`: `parseCompiledEnv` now returns `aios` (`parseAiosConfig`).
- `src/app/composition-root.ts`: builds `AiosEventLog` (window + forward onto
  the shared runtime event bridge), `AiosMetrics`, `AiosService` (injects the
  orchestrator + the five team services), `AiosPipeline` (injects the AG-001
  classifier, request-actor registry, policy, service, event log, metrics),
  and `AiosGateway`; exposes `services.aios` and `health.probeAios`.
- `src/app/runtime.ts`:
  - `POST /api/ai/request` — body → `AiosRequest` → `aios.request` (200) or a
    typed `sendAiosError`.
  - `GET /api/ai/status` — overall snapshot or `?requestId=` per-request.
  - `POST /api/ai/cancel` — `{ requestId }`, 400 `requestId_required` when
    missing.
  - `/health` gains the `aiOperatingSystem` block
    (`enabled / healthy / activeRequests / completedRequests / requestCounts /
statusCounts`) via `defaultHealth(..., aiosInfo?)`.

## 8. Observability

- Typed append-only `AiosEvent`s: stage completions, execution outcomes and
  failure events — ids/statuses/stages only, never prompts, payloads or
  secrets; forwarded onto the AG-002 runtime event bridge.
- Deterministic in-memory `AiosMetrics`: per-intent request counts, status
  counts, latency accumulator/average and ring-window events.

## 9. Fixes & hardening applied during the sprint

- Removed temporary `DEBUG-META-KNOBS` / `DEBUG-BUILD-TAIL` diagnostics and
  deleted scratch test files.
- **Workflow delay-knob merge** (all five teams): `readKnobNumber(request
.metadata, '<team>.delayMs')` added per workflow file and spread into
  `sharedInput`, so the workflow path honours `aios.delayMs` — the single
  capability path already did — making PARTIAL/TIMED_OUT/CANCELLED
  reproducible through the default `project.create` workflow (previously the
  merge produced SUCCESS in ~50 ms).
- **AG-003 registration** fixed `AGENT_EXECUTOR_UNAVAILABLE` for
  `knowledge.search` / `platform.help` through the orchestrator tail.
- Freelancer integration assertion aligned to the served capability
  (`proposal.generate`, not the unsupported `proposal.submit`); admin
  scenarios carry `adminScopes` so the scoped authorization path (BR-ADM-1) is
  exercised end-to-end.

## 10. Tests

- `tests/unit/app/ai-operating-system-integration.test.ts` (18 scenarios):
  health block; five team routes to SUCCESS (client `project.create`,
  freelancer `proposal.generate`, marketing `marketing.research`, marketplace
  `contract.generate`, admin `admin.analytics`); orchestrator tail
  (`knowledge.search`, `platform.help`); deterministic PARTIAL, TIMED_OUT,
  CANCELLED (incl. `statusCounts` after cancel); idempotent replay;
  concurrent-key 409 conflict; fail-closed 422 unknown intent, 400 secret,
  413 oversize, 400 empty text, 403 Guest scope; per-request status +
  cancel-input validation.
- `tests/unit/ai-operating-system/*.test.ts` (12 files): config (fail-closed),
  errors + HTTP mapping, schemas (bounded), security (secret/injection),
  pipeline stage chain, gateway (claim/replay/conflict, status shape),
  idempotency, metrics, policy matrix, events, execution-result and
  request-context route derivation.
- `tests/unit/agents/runtime/knowledge-runtime-agent.test.ts` (6): identity,
  capability/category, `runtime.delayMs` clamping + cancellation, `runtime.fail`
  knob, answer shape with citations, empty-query ⇒ no citations + confidence 0.
- `tests/unit/agents/client-ai-team/workflows-knob.test.ts` (3): knob injected
  into every task input, omitted when absent, cancellation forwarded.
- Full gates: `tsc --noEmit` (exit 0), `eslint .`, `prettier --check`,
  full `vitest run`, `npm run build` — all green.

## 11. Trade-offs & notes

- The AIOS is deliberately **thin**: intent classification stays with AG-001's
  classifier and routing with AG-001's registry data, so there is no second
  opinion or drift surface. Fine-grained authorization remains the owning
  team's job (the admin team re-enforces BR-ADM-1 inside its workflows).
- Single-path latency knobs existed per team; making the **workflow** path
  honour them was the minimal change that turns the aggregation contract into
  deterministic, assertable scenarios without introducing a parallel
  single-path execution mode.
- The orchestrator tail's AG-003 is deterministic and never fabricates
  knowledge; citations are bounded generated representatives of the provided
  input, and empty input reports zero confidence. Real RAG over the knowledge
  manager remains a future integration.
- Status/cancel surfaces expose aggregate counters and stage labels only —
  never agent results, prompts or secrets.
