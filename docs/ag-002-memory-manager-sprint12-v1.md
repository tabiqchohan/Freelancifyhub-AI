# AG-002 Memory Manager — Sprint 12 (Production Security & Retrieval Correctness v1)

## 1. Sprint objective

Fix ONLY the security and retrieval-correctness issues identified by the final
production audit for AG-002, before any of the deferred production infrastructure
(PostgreSQL, durable persistence, composition root, real AgentExecutor, AG-003,
AG-004, LLM integration, vector search, external integrations) is introduced.

Sprint 12 delivers: the CRIT-1 retrieval leak fix, read-path security-clearance
enforcement, canonical sensitive-data redaction, event-log replay authorization,
a security boundary matrix, and comprehensive security regression coverage.

## 2. Audit findings addressed

| Finding                                                                                | Status                                           |
| -------------------------------------------------------------------------------------- | ------------------------------------------------ |
| CRIT-1 — Retrieval scope/security filters computed but discarded                       | **FIXED**                                        |
| HIGH — Read-path security clearance enforcement missing                                | **FIXED**                                        |
| HIGH — Canonical sensitive-data redaction consistency                                  | **FIXED**                                        |
| HIGH — Event-log authorization/sanitization                                            | **FIXED** (replay gate)                          |
| CRIT-2/3/4/5/6 — durable persistence, composition root, real executors, runtime wiring | **DEFERRED** (explicitly out of Sprint 12 scope) |

## 3. Retrieval bug root cause

In `services/retrieval.service.ts`, the pipeline computed `authorized`,
`scopeFiltered` and `securityFiltered` collections but **discarded** the latter
two. Scoring/ranking ran solely on `authorized`:

- `scopeFiltered` (namespace/scope) and `securityFiltered` (clearance) were
  logged but never propagated to the response.
- The only clearance enforcement relied on the injected `SecurityLevelPolicy`;
  there was no defense-in-depth gate at the retrieval boundary.

A permissive (or mis-configured) authorization layer, or a path that trusted
only the matrix+scope gate, could therefore return out-of-scope or
insufficient-clearance records.

## 4. Retrieval fix

`retrieval.service.ts` now scores and ranks `securityFiltered` (the fully
authorized, scope-filtered AND security-filtered candidates) instead of
`authorized`:

- Unauthorized, out-of-scope, ownership-violating and insufficient-clearance
  records can no longer reach the response, snippets or statistics.
- `filteredCount` is corrected to `candidates.length - securityFiltered.length`.
- Filtering occurs before scoring/ranking; deterministic ordering is preserved.
- A strengthened regression test asserts only `INTERNAL` remains for an
  `INTERNAL`-clearance actor (previously asserted the leak).

## 5. Read-path security

Every read/retrieval path was audited (`getMemory`, `retrieveMemory`,
RetrievalService, ContextIntegrationService, consolidation candidate reads).
All of them now route through the composite `AuthorizationService.authorize`
(validated actor → matrix permission → namespace scope → ownership → security
clearance → lifecycle) with fail-closed semantics:

- `memory.service.ts::retrieveMemory` previously used `MemoryAccessPolicy.can`
  (matrix+scope only). It now calls `authorizationService.authorize` with
  `MemoryPermission.Read` per candidate after `validateMemoryActor`.
- `getMemory` already enforced the full contract via `assertCan`.

## 6. Clearance enforcement

Reused the existing security model — no new model invented:

- `MemoryActor.securityClearance` + `SecurityLevelPolicy` drive clearance.
- A caller with `INTERNAL` clearance cannot obtain `CONFIDENTIAL` memory through
  any audited read path; `CONFIDENTIAL` can read allowed lower levels per policy.
- Fail-closed on missing/invalid actor context, missing/unknown/malformed
  security level (validators reject unknown groups and levels).

## 7. Redaction audit

Canonical redaction is centralized in `utils/sanitize.ts` (`redactSecrets`,
`isSecretKeyName`, `isLikelySecret`) and `events/sanitize.ts`
(`sanitizeEvent`, `sanitizeEventMetadata`). Sprint 12:

- Expanded `SECRET_KEY_PATTERN` / `isLikelySecret` with compound keys
  (`apikey`, `accessToken`, `refreshToken`, `userPassword`, `sessionToken`).
- Retrieval snippets now use canonical `redactSecrets` for structured content
  and a new `redactInlineSecrets` for raw string content (whole `key: value`
  pair redacted so the key name does not leak).
- Redaction produces safe copies — the original record is never mutated.

## 8. Event security

- `events/log.ts` sanitizes secret-bearing metadata on append; tombstones stay
  content-free; malformed/duplicate/out-of-order events fail closed.
- `services/replay.service.ts` gains a backward-compatible, fail-closed
  **actor namespace-scope gate**: when an `actor` is supplied it must be a valid
  actor whose namespace allow-list includes the requested namespace, otherwise
  replay is denied (`MemoryAccessDeniedError`). Replay cannot resurrect erased
  memory and never reconstructs other namespaces. Callers that use replay as an
  internal primitive without an actor are unchanged.

## 9. Determinism review

Reviewed `ContextIntegrationService` for `Math.random()`/`Date.now()`: the only
nondeterministic source is an internal `generateTraceId()` fallback (a dynamic
correlation field, explicitly exempted). `DefaultScorer` is deterministic given
an identical `now`. Retrieval scores vary by ~1e-12 only because `recencyScore`
depends on the wall-clock `now` — an inherently dynamic field; with a
`FixedClock`, scores are bit-identical. No fix to the output contract required.

## 10. Tests added

56 new tests across 5 new regression suites (no existing test deleted or
weakened):

| Suite                                   | Coverage                                                    |
| --------------------------------------- | ----------------------------------------------------------- |
| `security-retrieval-regression.test.ts` | CRIT-1 (10 cases) + read-path clearance (2)                 |
| `redaction-regression.test.ts`          | canonical redaction, snippets, events (19)                  |
| `event-security-regression.test.ts`     | replay authorization/isolation, content-free, tombstone (7) |
| `security-regression-sprint12.test.ts`  | Phase 7 categories A–O (15)                                 |
| `determinism-regression.test.ts`        | identical-input → identical logical output (3)              |

Plus the corrected `retrieval.service.test.ts` clearance assertion (HIGH-5).

## 11. Existing tests preserved

All 1172 baseline tests still pass; the single corrected assertion in
`retrieval.service.test.ts` was **strengthened** (from expecting the leak to
expecting the exclusion), satisfying the "no assertion weakened" rule.

## 12. Security matrix

| PATH                          | AUTH             | SCOPE | OWNERSHIP | CLEARANCE | LIFECYCLE | SANITIZED                         | STATUS     |
| ----------------------------- | ---------------- | ----- | --------- | --------- | --------- | --------------------------------- | ---------- |
| create                        | ✓                | ✓     | ✓         | ✓         | ✓         | ✓ (logs)                          | OK         |
| update                        | ✓                | ✓     | ✓         | ✓         | ✓         | ✓ (logs)                          | OK         |
| read (getMemory)              | ✓                | ✓     | ✓         | ✓         | ✓         | ✓ (logs)                          | OK         |
| retrieve (RetrievalService)   | ✓                | ✓     | ✓         | ✓         | ✓         | ✓ (snippet)                       | OK         |
| retrieve (retrieveMemory)     | ✓                | ✓     | ✓         | ✓         | ✓         | n/a (full records are authorized) | OK (fixed) |
| context integration           | ✓                | ✓     | ✓         | ✓         | ✓         | ✓ (snippet/metadata)              | OK         |
| consolidate (candidate reads) | ✓                | ✓     | ✓         | ✓         | ✓         | ✓                                 | OK         |
| archive/restore/expire        | ✓                | ✓     | ✓         | n/a*      | ✓         | ✓ (logs)                          | OK         |
| erase (DSR)                   | ✓                | ✓     | ✓         | ✓         | n/a*      | n/a (tombstone)                   | OK         |
| event (append)                | n/a (producer)   | —     | —         | —         | —         | ✓ (metadata)                      | OK         |
| replay                        | ✓ (actor opt-in) | ✓     | —         | —         | —         | ✓                                 | OK (fixed) |
| response/snippets             | ✓                | ✓     | ✓         | ✓         | ✓         | ✓                                 | OK         |

\* Lifecycle transitions and DSR erasure use their own dedicated policies
(LifecycleStatePolicy / `assertCanErase`) by design; these are mutation
operations, not content reads.

## 13. Quality gates

- Tests: **1228 passed / 1228** (94 files) — baseline 1172
- Typecheck: **0 errors**
- Lint: **0 errors**
- Build: **SUCCESS**

## 14. Files changed

Source:

- `services/retrieval.service.ts` — CRIT-1 fix, canonical redaction, inline redaction
- `services/memory.service.ts` — read-path clearance + removed unused private field
- `services/replay.service.ts` — actor namespace-scope gate
- `utils/sanitize.ts` — compound sensitive-key pattern expansion

Tests:

- `retrieval.service.test.ts` — corrected clearance assertion
- 5 new regression suites (see §10)

Docs:

- `docs/ag-002-memory-manager-sprint12-v1.md` (this file)

## 15. Remaining limitations

- Event-log **store-layer** queries (`EventLog.query`/`getById`) remain
  actor-free primitives; authorization/scoping happens at the service layer
  (replay). A fully actor-specialized log store is a larger redesign deferred
  intentionally.
- Replay actor gate is opt-in for backward compatibility; callers treating the
  log as an internal primitive are unchanged (documented gap).
- The `generateTraceId` fallback uses `Math.random`/`Date.now` — only for
  dynamic correlation ids, not content.

## 16. Deferred production infrastructure

Deliberately NOT implemented in Sprint 12: PostgreSQL/Neon, durable persistence,
production composition root, real AgentExecutor, OpenClaw runtime, AG-003,
AG-004, LLM integration, vector/embedding search, social, payments, external APIs.

## 17. Architecture compliance

Reuses the existing `SecurityLevelPolicy`, `AuthorizationService`,
`MemoryActor`, permission matrix, namespace/ownership policies, validators and
event-log design. No new security model. No architecture change introduced to
fill the matrix.

## 18. Scope compliance

Changes are limited to retrieval correctness, security enforcement, canonical
redaction, event-log security, deterministic-output verification, and security
regression tests. No AG-001/AG-003/AG-004 changes, no database or external
integrations.

## 19. Final verification

All quality gates green, diff reviewed for scope creep, CRIT-1 has a regression
test that fails against the old implementation and passes against the new one.

## 20. Commit status

NOT committed, NOT pushed. All Sprint 12 changes remain in the working tree per
the Sprint 12 commit rule.
