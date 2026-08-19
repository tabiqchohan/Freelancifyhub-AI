# AG-001 Master Orchestrator — Hardening Sprint v1

Scope: `prompts/prompts18`. Fixes the Critical and High findings from
`docs/ag-001-sprints-1-7-audit-v1.md` with the smallest safe changes. No
architecture redesign, no Sprint 9 work.

---

## 1. Baseline

| Gate      | Result                  |
| --------- | ----------------------- |
| Tests     | 489 passing (per audit) |
| Typecheck | clean                   |
| Lint      | clean                   |
| Build     | clean                   |

---

## 2. Final Result

| Gate      | Result                                 |
| --------- | -------------------------------------- |
| Tests     | **540 passing** (53 files) — 489 → 540 |
| Typecheck | clean (`tsc --noEmit`)                 |
| Lint      | clean (`eslint .`)                     |
| Build     | clean (`tsc -p tsconfig.build.json`)   |

---

## 3. Audit Findings Fixed

| ID  | Finding                                                                                            | Disposition                                                   |
| --- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| C-1 | Sensitive step output can reach `AggregatedResponse` unsanitized                                   | Fixed — canonical sanitizer at the aggregation trust boundary |
| C-2 | Overall timeout can race completion and return `COMPLETED`                                         | Fixed — authoritative deadline + single terminal-state settle |
| H-1 | `SATURATION_UNITS=2` over-saturates single-word intents                                            | Fixed — saturation floor raised to 3                          |
| H-2 | Routing can select draft/disabled agents; stale `selectedAgent` on escalation                      | Fixed                                                         |
| H-3 | `maxRoutingCost`/`minConfidence`/`requiredPermissions`/`allowedRoles` validated but never enforced | Fixed                                                         |
| H-4 | `EXECUTION_MAX_CONCURRENT_STEPS` was metric-only                                                   | Fixed — `ConcurrencyLimiter` wired into the engine            |
| H-5 | 6 dead execution flags                                                                             | Connected/document justified; no config removed               |
| H-6 | Sanitizer key gaps (`pwd`, `passphrase`, compounds)                                                | Fixed — canonical sanitizer extended                          |
| H-7 | Missing security + stress coverage                                                                 | Added — see §12                                               |

---

## 4. Security Model (C-1 / H-6)

### Canonical mechanism

`src/agents/ag-001-master-orchestrator/aggregation/utils/index.ts` owns the one
canonical sanitizer:

- `canonicalKey()` normalises any key to `snake_case` (camelCase splitting +
  separator collapsing + lower-casing).
- `SENSITIVE_TOKEN_PATTERN` matches `password|passwd|pwd|passphrase|token|secret|
authorization|credentials?|cookie|ssn|cvv|pan|pin` as whole tokens.
- `SENSITIVE_COMPOUND_PATTERN` matches `api_key|apikey|access_token|refresh_token|
session_token|session_id|auth_token|client_secret|private_key|access_key`.
- `isSensitiveKey()` is case-insensitive and substring-safe (e.g. `company`,
  `author`, `spin` are **not** flagged).
- `sanitizeRecord()` recurses through nested objects and arrays, **omits**
  sensitive keys entirely (never blanks values), and is **non-mutating**.

### Trust boundary

`sanitizeRecord(step.output)` and `sanitizeRecord(step.metadata)` are applied in
the **normalizer** (`aggregation/normalizers/index.ts:137-144`), i.e. at the
internal trust boundary, before ordering/grouping/formatting. The final
`AggregatedResponse` is assembled exclusively from normalized (already safe)
results, so both the normalized result and the aggregated response are safe —
the formatter is not relied upon as a sanitization point.

### Requirements met

- Key list from prompts18 C-1/H-6 covered (plus `ssn`, `cvv`, `pan`, `pin`,
  `session_id`, `access_key` already in the pre-existing pattern).
- Case-insensitive, nested objects, nested arrays, deep nesting, non-mutating.
- Protects output, metadata, errors, warnings, statistics, formatted results and
  logs (logs never include step payloads).
- Regression tests assert secret values cannot be found anywhere in the
  serialized `AggregatedResponse`.

---

## 5. Timeout Model (C-2)

`src/agents/ag-001-master-orchestrator/execution/`:

- `ExecutionStateManager.settle(state)` is the **single terminal-state
  transition mechanism**. Once a terminal state (`Completed`, `Failed`,
  `Cancelled`, `TimedOut`) is committed, any later transition is ignored.
- The engine's overall deadline (`createDeadline`) races the strategy work.
  After the race, an **authoritative wall-clock check** re-evaluates the
  deadline: if `Date.now() - startedAt >= deadlineMs` even though the work
  promise won the race, the run is forced to `TimedOut`. A completion after the
  deadline can never upgrade the status.
- Timers are always cleaned up (`deadline.clear()` in a `finally`, plus a
  defensive sweep for the step timers). No unhandled rejections: the work
  promise is caught before the final state is computed.
- Cancellation and timeout interact deterministically: whichever terminal
  event lands first wins; `settle()` makes that atomic.
- Covered by 6 timeout tests plus `settle()` unit tests (terminal-commit,
  non-terminal rejection).

---

## 6. Concurrency Model (H-4)

- `src/agents/ag-001-master-orchestrator/execution/concurrency/index.ts`
  provides a lightweight `ConcurrencyLimiter` (semaphore, no worker queue).
- The engine runs every step through the limiter, so maximum active steps never
  exceeds `EXECUTION_MAX_CONCURRENT_STEPS`. Queued steps wait; slots are
  released on success **and** rejection; dependency rules are unchanged;
  parallel plans stay parallel up to the limit; retries go through the same
  limiter.
- Tests measure peak observed concurrency directly (limit 1, limit 2, limit >
  step count, slot release on rejection, default ceiling).

---

## 7. Routing Constraint Model (H-2 / H-3)

`src/agents/ag-001-master-orchestrator/routing/`:

- **Status eligibility**: `buildCandidates` now drops agents that are not
  `isRoutableStatus` (Draft/Retired). Draft/disabled agents can no longer be
  selected as primary, appear as candidates, or leak into multi-agent plan
  candidate lists. An intent served only by disabled agents escalates
  `NO_MATCH`.
- **Stale `selectedAgent`**: when the preferred agent is unavailable with no
  fallback (or any decision escalates), `selectedAgent` is cleared —
  `resolveFallbacks` no longer returns the stale primary, and the engine
  enforces `selectedAgent === undefined` for every `Escalated` decision. A
  fallback decision always carries the actual fallback agent.
- **Constraint enforcement** (all already defined by the architecture):
  - `maxRoutingCost` — enforced as a hard candidate filter via
    `constraintViolations` (agent cost defaults to 1 when unset). `ROUTING_MAX_COST`
    is now connected: `effectiveConstraints()` in the engine merges
    `ROUTING_MAX_COST` as the ceiling unless the request supplies a stricter
    value. `defaultConstraints(config)` is now actually exercised.
  - `minConfidence` — hard floor: candidates scoring below it are dropped;
    all-below ⇒ `NO_MATCH` escalation. (Config `ROUTING_CONFIDENCE_LOW` is
    deliberately **not** merged as `minConfidence`; it already gates
    `LOW_CONFIDENCE` escalation.)
  - `requiredPermissions` — enforced against the agent's declared permissions;
    `AgentConfiguration` gained optional `permissions` (and `cost`). Missing
    permission ⇒ candidate dropped; none left ⇒ `NO_MATCH`.
  - `allowedRoles` — enforced engine-side against the caller role via a new
    `resolveEscalation` check ⇒ `PERMISSION_DENIED`.
  - `requiredCapability`, `excludedAgents`, `allowedStatuses`, availability —
    already enforced; unchanged.
- Scorer cost factor now reflects `agent.configuration.cost ?? 1` (was hard-coded 1).

---

## 8. Intent Scoring Change (H-1)

`src/agents/ag-001-master-orchestrator/intent/`:

- `SATURATION_UNITS` raised 2 → 3 (`classifiers/index.ts`).
- `PHRASE_WEIGHT` raised 2 → 3 (`matchers/index.ts`).
- New behaviour: a single keyword scores ≈0.33 (weak) instead of 1.0; two
  unrelated single keywords score ≈0.67 (moderate, no false saturation); a
  phrase scores 1.0 (saturates). Thresholds, phrase/keyword matching, unknown
  intent and ambiguity handling are unchanged.

---

## 9. Configuration Cleanup (H-5)

Six execution flags were audited (A=used, B=required-but-unused, C=obsolete,
D=duplicate):

| Flag                               | Class | Disposition                                                                                                                                                                                           |
| ---------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EXECUTION_CANCELLATION_ENABLED`   | B     | Connected — guards `cancel()` + cancellation race arm                                                                                                                                                 |
| `EXECUTION_IDEMPOTENCY_ENABLED`    | B     | Connected — guards duplicate-scheduling                                                                                                                                                               |
| `EXECUTION_PARALLEL_ENABLED`       | B     | Connected — Parallel/Hybrid modes throw `UnsupportedExecutionModeError` when disabled                                                                                                                 |
| `EXECUTION_CONDITIONAL_ENABLED`    | B     | Connected — Conditional mode gated                                                                                                                                                                    |
| `EXECUTION_DEFAULT_TIMEOUT_MS`     | B     | Connected — overall-timeout fallback when the plan omits a budget                                                                                                                                     |
| `EXECUTION_DEFAULT_RETRY_ATTEMPTS` | B     | Kept + documented — validation floor (MAX ≥ DEFAULT via `superRefine`); planning always supplies explicit retry policies, so a runtime fallback would wrongly grant `maxRetries:0` steps two attempts |

No configuration was removed; every flag is now enforced or justified.
`isExecutionFeatureEnabled()` routes all six features.

---

## 10. Fixes

- **C-1 / H-6**: canonical sanitizer extended + applied at the normalizer
  boundary.
- **C-2**: `ExecutionStateManager.settle()` + engine post-race deadline check +
  `deadline.clear()` hygiene.
- **H-1**: saturation/weight formula change.
- **H-2**: status-filtered candidate building + stale-selection prevention.
- **H-3**: enforced `maxRoutingCost` (incl. `ROUTING_MAX_COST`),
  `minConfidence`, `requiredPermissions`, `allowedRoles`.
- **H-4**: `ConcurrencyLimiter` + engine wiring.
- **H-5**: connected four boolean gates, timeout fallback, retry floor.
- **H-7**: security/stress test files (see §12).

---

## 11. Tests

| Area        | Files                                                             | Notable cases                                                                                                                                               |
| ----------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Aggregation | utils, compatibility, stress                                      | sanitizer key coverage, nested arrays/objects, casing, deep nesting, non-mutating, large sets                                                               |
| Execution   | engine, timeout, concurrency, retry, config, cancellation, stress | settle atomicity, deadline races, timer cleanup, concurrency peaks, dead-flag gates, retry+concurrency, cancellation+concurrency, 8 simultaneous executions |
| Intent      | classifier                                                        | single word, multi word, phrase, conflicts, unknown, ambiguity                                                                                              |
| Routing     | engine                                                            | direct/capability/fallback/escalation, draft/disabled, stale selection, every constraint                                                                    |

New test files: `execution/concurrency.test.ts`, `execution/stress.test.ts`,
`aggregation/stress.test.ts`. Existing tests updated only where they encoded
the pre-fix buggy behaviour (draft/retired agents being routable).

---

## 12. Security + Stress Tests (H-7)

- Secret leakage: output, nested output, metadata, mixed casing, arrays.
- Deeply nested secret stripping at depth 6; keys omitted, not blanked.
- Large result sets (80 results), large metadata (50 keys + secret).
- Non-mutation of original step outputs.
- Timeout races: before completion, completion after deadline, exact-boundary,
  timer sweep, settle atomicity.
- Concurrency: peak ≤ limit (1/2/3), default ceiling, slot release on
  rejection, retry under limit, cancellation under parallel load, 8 concurrent
  executions with isolated results.

---

## 13. Remaining Known Issues

- `defaultConstraints(config)` still returns `minConfidence` from
  `ROUTING_CONFIDENCE_LOW`; the engine intentionally does not merge that value
  (it would pre-empt `LOW_CONFIDENCE` escalation). The helper is used for
  `maxRoutingCost`; the `minConfidence` member is documented as config-driven
  escalation only.
- Agents in the default catalog declare no `cost`/`permissions`; enforcement
  therefore defaults to cost 1.0 and no permissions. Catalog enrichment is a
  business-agent concern (out of scope).
- `allowedRoles` remains intent-level for agents (agents do not declare roles
  in the Sprint 4 model); the constraint is enforced against the caller role.

---

## 14. Explicit Confirmations

"No AG-002, AG-003, AG-004 integration, external API integration, LLM
integration, social media integration, payment integration, database
integration, or production business agents were implemented."

"No source files outside the intended hardening scope were modified."

---

## 15. Files Changed (intentional, hardening scope only)

- `src/agents/ag-001-master-orchestrator/aggregation/normalizers/index.ts`
- `src/agents/ag-001-master-orchestrator/aggregation/utils/index.ts`
- `src/agents/ag-001-master-orchestrator/execution/config/index.ts`
- `src/agents/ag-001-master-orchestrator/execution/engine/index.ts`
- `src/agents/ag-001-master-orchestrator/execution/index.ts`
- `src/agents/ag-001-master-orchestrator/execution/state/index.ts`
- `src/agents/ag-001-master-orchestrator/execution/concurrency/index.ts` (new)
- `src/agents/ag-001-master-orchestrator/intent/classifiers/index.ts`
- `src/agents/ag-001-master-orchestrator/intent/matchers/index.ts`
- `src/agents/ag-001-master-orchestrator/interfaces/execution-context.ts`
- `src/agents/ag-001-master-orchestrator/routing/engine.ts`
- `src/agents/ag-001-master-orchestrator/routing/escalations/index.ts`
- `src/agents/ag-001-master-orchestrator/routing/fallback/index.ts`
- `src/agents/ag-001-master-orchestrator/routing/matchers/index.ts`
- `src/agents/ag-001-master-orchestrator/routing/scorers/index.ts`
- Test files: aggregation (utils, compatibility, stress), execution (config,
  timeout, concurrency, stress), intent (classifier), routing (engine).
