# LLM Provider & AI Reasoning Layer — Sprint 17 (Reasoning Foundation v1)

## 1. Objective

Build a **provider-agnostic LLM abstraction and AI reasoning layer** that can be
consumed by the existing AG-001 runtime/orchestrator architecture, following the
repository's production standards (typed contracts, dependency injection,
fail-closed security, explicit configuration, auditability, deterministic tests).

The core domain depends only on `LLMProvider` — never on a concrete SDK. Sprint
17 v1 ships a **deterministic mock provider** (the main test/staging path) and
one **minimal HTTP provider** for any OpenAI-compatible endpoint. Semantic/vector
retrieval and autonomous tool-calling are **NOT** introduced by this sprint; both
remain exactly as previously supported by the existing architecture.

Agent execution remains deterministic by default. Reasoning is an explicit
capability (`agent.reasoning` / `requiresReasoning`) that an agent declares; every
existing deterministic agent (including the AG-004 calculator) is untouched.

## 2. Scope

In scope:

- `src/llm/` domain module: types, config, errors, retry, security, events,
  metrics, providers, reasoning service, barrel export.
- LLM environment configuration added to `src/app/env.ts` (base/memory/knowledge/
  tools preserved; `llm` added).
- Composition-root wiring: provider resolution, reasoning service,
  `ProductionAgentExecutor` injection — with AG-001/002/003/004 wiring intact.
- Executor reasoning prelude: capability-driven, fail-closed, cancellation-aware.
- Health/readiness: `llm` section in `/healthz` + `/health`, dedicated
  `GET /api/llm/status` (safe metadata only).
- Full unit/integration/regression suite.

Out of scope (deferred): multiple SDK providers, streaming, function/tool-calling
loops, autonomous agent self-execution, real live-API tests in the default suite.

## 3. Architecture

```
AG-001 context builder (AG-002 memory / AG-003 knowledge / AG-004 tools)
        ↓
ProductionAgentExecutor  (capability check: agent.reasoning)
        ↓
AIReasoningService  (binds messages, retry, timeout, redaction)
        ↓
LLMProvider  (mock | http | disabled)
```

- Composition root constructs concrete providers (`src/app/composition-root.ts`).
- The executor only depends on the `AIReasoningServiceContract`.
- When LLM is disabled, a `DisabledLLMProvider` is wired; reasoning requests fail
  closed with `REASONING_UNAVAILABLE` instead of pretending a response exists.
- `AIReasoningService` never touches the database and never bypasses AG-002/003/004.

## 4. LLM Provider Abstraction

Contracts in `src/llm/types/index.ts`:

- `LLMProvider` — `readonly id`, `readonly model`, `generate(request, options?)`.
- `LLMMessage` — `role` (`system | user | assistant`) + `content`.
- `LLMRequest` — messages, optional model override, temperature, max output
  tokens, optional metadata.
- `LLMResponse` — text, provider, model, usage, finish reason, request ID.
- `LLMUsage` — input/output/total tokens (optional when a provider omits them).
- `LLMRequestOptions` — `AbortSignal`, per-call timeout, request ID.

No SDK-specific types are exposed from the domain layer.

## 5. Configuration

LLM config follows the existing Zod + `parseCompiledEnv` pattern
(`src/llm/config/schema.ts` + `src/llm/config/index.ts`). `src/app/env.ts`
extends `Environment` with `llm` while preserving `base`, `memory`, `knowledge`,
`tools`.

Validation rules:

- `LLM_ENABLED=false` (default) → safe boot, provider becomes `disabled`.
- `LLM_ENABLED=true` + `LLM_PROVIDER=mock` → deterministic mock, no credentials.
- `LLM_ENABLED=true` + `LLM_PROVIDER=http` + missing/blank `LLM_API_KEY` →
  **fails closed** at parse time with `LLMConfigurationError`.
- `LLM_ENABLED=false` + `LLM_PROVIDER=http` → boots with a `disabled` provider
  (no key required).
- Unknown provider, invalid timeout/retries/temperature/max-output-tokens →
  parse-time rejection.

Defaults: timeout 30000ms, retries 2, temperature 0.2, max output tokens 1024,
max context bytes 64 KiB, base URL `https://api.openai.com/v1`,
model `mock-model-1.0`.

The API key is never logged, never serialized into errors, events, metrics, or
health payloads, and never present in test snapshots. Composition maps a parse
failure to boot failure (`DiagnosticError`) with the key value redacted.

## 6. Provider Factory

`src/llm/providers/index.ts` exposes `createLLMProvider(config)` used by the
composition root:

- `LLM_ENABLED=false` → `DisabledLLMProvider` (throws `LLMConfigurationError` on
  generate).
- `LLM_PROVIDER=mock` → `MockLLMProvider` (deterministic, off-network).
- `LLM_PROVIDER=http` → `HttpLLMProvider` (only reachable when validation passed).

Unsupported providers are rejected by the config layer before the factory runs.

## 7. AIReasoningService

`src/llm/services/reasoning.ts` implements `AIReasoningServiceContract`:

- Accepts `ReasoningRequest` (system instruction, user input, optional context,
  memory/knowledge context items, tool results, correlation ID).
- Builds bounded messages via `buildReasoningMessages` (single system + one
  delimited user message), enforces the context-byte budget, and drives
  `generateWithRetry` (bounded exponential backoff, timeout race, AbortSignal).
- Returns `ReasoningResult` (output, provider, model, usage, latency,
  correlationId), records LLM events, and updates LLM metrics.
- Errors are normalized to the `LLMError` hierarchy; cancellation surfaces as
  `LLMReasoningError`/`LLMCancelledError` without retry.

## 8. ProductionAgentExecutor Integration

`src/agents/runtime/executor.ts` accepts an optional `reasoningService` (DI; no
hard-coded construction). Before executing an agent it runs `resolveReasoning`:

- Agents **without** the `agent.reasoning` capability stay fully deterministic —
  the reasoning service is not invoked and no LLM request is made.
- Agents **with** `requiresReasoning` run the reasoning prelude. Context already
  assembled by AG-001 (memory via AG-002, knowledge via AG-003, tool results via
  AG-004) is injected into the reasoning request.
- The reasoned output is delivered to the agent through `context.reasoning`.
- Failure semantics: service disabled/missing → `REASONING_UNAVAILABLE`
  (non-retryable); cancellation → `REASONING_CANCELLED`; anything else →
  `REASONING_FAILED`. The prelude never fabricates a result.

## 9. Context Flow

```
request → AG-001 validation → intent → context builder → routing → planning
→ execution → executor → reasoning prelude → AIReasoningService → LLM provider
→ reasoning result → agent.execute(context.reasoning) → aggregation → response
```

`AIReasoningService` is a capability, not the orchestrator. Orchestration remains
entirely in AG-001.

## 10. Memory / Knowledge / Tool Boundaries

- The executor passes already-prepared context (AG-002/003/004 results) to the
  reasoning service — it never queries these subsystems itself.
- Context items carry namespace/security classification; the reasoning request
  respects scope and only includes what AG-001 already authorized.
- Tool output is injected from AG-004 results; tool execution can never be
  triggered by the LLM through this pathway.

## 11. Security

`src/llm/security/index.ts`:

- All untrusted content (user input, memory, knowledge, tool output) is
  JSON-encoded and wrapped in `<untrusted_context>` delimiters.
- Values are sanitized with `sanitizeReasoningValue`, reusing AG-002's
  `redactSecrets` (secret-key/secret-value redaction) plus a new
  connection-string guard (`scheme://user:pass@host`) so internal database
  connections can never reach the prompt.
- Embedded boundary markers are neutralized
  (`ESCAPED_BOUNDARY = "\<untrusted_context\>"`) so injected content cannot
  create additional delimiters or suggest new instructions.
- The default system instruction forbids revealing API keys, system secrets,
  credentials, and private infrastructure details.
- Truncation is UTF-8 byte-aware and never splits a code point.

This is deliberate v1 defense, not a claim of complete prompt-injection
prevention.

## 12. Retry / Timeout

`src/llm/retry/index.ts` (`generateWithRetry`):

- Configurable max retries, exponential backoff, bounded delay, injectable
  `sleep` (tests never rely on real durations).
- Classification-aware: auth/invalid-request/validation/config errors and
  cancellations are never retried; transient network, rate-limit, 5xx, and
  guard-timeouts may be retried.
- AbortSignal-aware: cancellation during backoff or in-flight aborts the chain.
- Each attempt runs under a real timeout race that tears down the fetch.

## 13. Errors

`src/llm/errors/index.ts` — `LLMError` hierarchy with safe `details` and an
explicit `retryable` flag:

`LLMConfigurationError`, `LLMAuthenticationError`, `LLMRateLimitError`,
`LLMTimeoutError`, `LLMNetworkError`, `LLMInvalidRequestError`,
`LLMProviderError`, `LLMResponseValidationError`, `LLMCancelledError`.

Error messages never include API keys, Authorization headers, credentials, or
full request payloads.

## 14. Events

`src/llm/events/index.ts` — `LLMEventLog` (in-memory, append-only) following the
AG-004 conventions: deterministic `id` factory (`lev_<uuid>`), `append`,
`getById`, `query`, `count`, `latest`, `clear`. Safe metadata only: request/
correlation ID, provider, model, timestamps, duration, success/failure, retry
count, token usage, error category. Raw prompts/responses and credentials are
never stored.

## 15. Metrics

`src/llm/metrics/index.ts` — `LLMMetrics` (in-memory, deterministic `snapshot`):
total/success/failure/timeouts/cancellations/retries, auth/validation failures,
rate limits, input/output tokens, and per-provider breakdown. No high-cardinality
labels — prompts, content, keys, and raw request IDs are never labels.

## 16. Health / Readiness

- `/healthz` and `/health` report an `llm` section with **configuration status
  only** (`enabled/configured/provider/model`) — health never calls the real LLM.
- `GET /api/llm/status` exposes provider status, executor availability, latest
  event-log entries/total, and a metrics snapshot. No credentials.
- A temporarily unavailable external LLM cannot fail `/health`.

## 17. Testing

Test files added (92 tests / 9 files):

- `tests/unit/llm/config.test.ts` — defaults, fail-closed key rule, invalid
  provider/timeout/retries/temperature/tokens, no key leakage in errors.
- `tests/unit/llm/providers.test.ts` — mock determinism/count/captured metadata;
  HTTP success + usage/finish-reason parsing, auth header, error mapping
  (401/429/5xx/400, malformed payload, network, timeout, cancellation).
- `tests/unit/llm/retry.test.ts` — first-try success, retry-then-success, max
  retries, permanent error not retried, cancellation during backoff, class-aware
  classification.
- `tests/unit/llm/security.test.ts` — system/user separation, boundary integrity,
  marker neutralization, redaction of secrets and connection strings.
- `tests/unit/llm/events.test.ts` / `metrics.test.ts` — log/metric behavior.
- `tests/unit/llm/reasoning.test.ts` — message construction, usage propagation,
  error normalization, provider swap, disabled fail-closed.
- `tests/unit/agents/runtime/executor-reasoning.test.ts` — deterministic agents
  stay deterministic (zero LLM calls), reasoning-capable agents route through the
  service, AG-001 context reaches reasoning, fail-closed codes, event log.
- `tests/unit/app/llm-integration.test.ts` — composition boot (disabled/mock/fail-
  closed), runtime health + `/api/llm/status` for disabled and mock providers.

No live API calls in the default suite. Real-provider integration tests can be
gated later behind `RUN_LLM_INTEGRATION_TESTS=true`.

## 18. Environment Variables

| Variable                | Default                     | Meaning                                   |
| ----------------------- | --------------------------- | ----------------------------------------- |
| `LLM_ENABLED`           | `false`                     | Master switch for the LLM/reasoning stack |
| `LLM_PROVIDER`          | `mock`                      | `mock` or `http`                          |
| `LLM_MODEL`             | `mock-model-1.0`            | Model identifier for requests             |
| `LLM_API_KEY`           | unset                       | Required when `LLM_ENABLED=true` + `http` |
| `LLM_BASE_URL`          | `https://api.openai.com/v1` | HTTP provider endpoint root               |
| `LLM_TIMEOUT_MS`        | `30000`                     | Per-attempt timeout                       |
| `LLM_MAX_RETRIES`       | `2`                         | Bounded retry count                       |
| `LLM_TEMPERATURE`       | `0.2`                       | Sampling temperature                      |
| `LLM_MAX_OUTPUT_TOKENS` | `1024`                      | Max output tokens                         |
| `LLM_MAX_CONTEXT_BYTES` | `65536`                     | User-message UTF-8 byte budget            |

No real values are documented; use placeholders only.

## 19. How to Enable LLM

1. `LLM_ENABLED=true`.
2. For the mock provider: `LLM_PROVIDER=mock` (no key needed).
3. For an OpenAI-compatible endpoint: `LLM_PROVIDER=http`, set `LLM_API_KEY`,
   optionally `LLM_BASE_URL`/`LLM_MODEL`. Boot fails closed if the key is unset.
4. An agent opts into reasoning by declaring the `agent.reasoning` capability and
   `requiresReasoning: true` (see `createRuntimeAgent`).

## 20. How to Use the Mock Provider

- In tests: `new MockLLMProvider({ config })` or the composition root with
  `LLM_ENABLED=true, LLM_PROVIDER=mock`.
- Deterministic canned responses; configurable simulated errors/latency;
  AbortSignal support; `capturedRequests()` call/count/metadata introspection.
- Requires no network.

## 21. Future Provider Expansion

New providers implement `LLMProvider` and are registered in
`createLLMProvider`. The config `LLM_PROVIDER` zod enum is extended per provider.
OpenAI/Anthropic/Google/OpenRouter/local models fit this seam without touching
domain code.

## 22. Known Limitations

- v1 has one production provider (OpenAI-compatible HTTP) — no streaming, no
  tool/function-calling loop.
- Context is bounded by a fixed byte budget; no semantic/vector retrieval.
- Prompt-boundary defense is deliberate v1 hardening, not guaranteed
  injection-proof.
- Mock provider latency simulation is bounded and injected, never wall-clock in
  tests.

## 23. Deferred Work

- Streaming responses, token-aware chunking, `<thinking>`/chain-of-thought modes.
- Multi-provider SDK integration and native AnomalyCo/OpenRouter transports.
- Agentic tool-calling loop (LLM chooses tools → AG-004 executes → re-reason).
- Persistent event/metric sinks and LLM audit retention.
- Live API integration tests behind an opt-in flag.

## Verification

- Tests: **1577 passed** (138 test files), up from 1485 / 129 files before
  Sprint 17; 92 new tests.
- Typecheck: **0 errors** (`tsc --noEmit`).
- ESLint: **0 errors** (`eslint .`).
- Build: `npm run build` success.
- Runtime smoke (built `dist/index.js` boot): `/healthz` + `/health` `ok` with
  `llm.enabled:false`, `/api/llm/status` returns executor/events/metrics.
- AG-002/AG-003/AG-004 regression: full suite green (durable Neon backend).
- Backward compatibility: AG-004 calculator (`10 / 2 + 7 → 12`) and all existing
  deterministic flows unchanged; startup requires no LLM key when LLM is disabled.
