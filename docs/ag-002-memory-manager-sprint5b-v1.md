# AG-002 Shared Memory Manager — Sprint 5B Memory Consolidation Engine

**Agent:** AG-002 · **Scope:** Sprint 5B — Memory Consolidation Engine · **Status:** Implemented
**Source of truth:** `docs/shared-memory-architecture-v1.md` · **Task:** `prompts/prompts26`

## Summary

Sprint 5B delivers the deterministic **Memory Consolidation Engine** (`MemoryConsolidationService`) inside the AG-002 service boundary. It deterministically identifies related / duplicate / compatible memory records and creates a consolidated `LONG_TERM` record according to an explicit, validated policy. It is **not** an LLM summarizer and never invokes embeddings, vector DBs, external APIs, or any non-AG-002 integration. Consolidation is deterministic, explainable, authorization-aware, lifecycle-aware, security-aware, namespace-aware, non-destructive, auditable, version-safe and dependency-injected.

All AG-001 + AG-002 Sprint 1–5A baseline tests continue passing. 31 new Sprint 5B tests are green. Full gates: `npm test` (**946 passing** = 915 baseline + 31 new), `npm run typecheck` (18 pre-existing errors only), `npm run lint` (27 pre-existing errors only), `npm run build` (2 pre-existing errors only) — no new errors introduced.

## Deliverables

| Area    | Files                                                                                                                                                                                   |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Config  | `config/schema.ts` — added `MEMORY_CONSOLIDATION_ENABLED`, `MEMORY_CONSOLIDATION_MIN_RECORDS`, `MEMORY_CONSOLIDATION_MAX_RECORDS`, `MEMORY_CONSOLIDATION_ALLOWED_TYPES` + defaults      |
| Events  | `events/index.ts` — added `MemoryConsolidated = 'MEMORY_CONSOLIDATED'` event type + optional safe fields (`consolidationId`, `sourceIds`, `outputId`, `candidateGroupSize`)             |
| Service | `services/consolidation.service.ts` — `MemoryConsolidationService` contract, `MemoryConsolidationServiceImpl`, `createMemoryConsolidationService` factory + all consolidation contracts |
| Barrel  | `services/index.ts` + `index.ts` — exported `MemoryConsolidationServiceImpl`, `createMemoryConsolidationService` + consolidation types                                                  |
| Tests   | `tests/unit/agents/ag-002-memory-manager/consolidation.service.test.ts` — 31 tests (A–Z + AB–AR)                                                                                        |
| Docs    | `docs/ag-002-memory-manager-sprint5b-v1.md` — this document                                                                                                                             |

## Consolidation Contracts

- `MemoryConsolidationService` / `MemoryConsolidationServiceImpl` — deterministic consolidation engine exposing `findCandidates`, `evaluate`, `consolidate`.
- `MemoryConsolidationPolicy` — `enabled`, `minRecords`, `maxRecordsPerOperation`, `allowedTypes`, `archiveSources` (default `false`).
- `MemoryConsolidationRequest` — `actor`, `namespace` (scope), optional `types` / `maxCandidates`, optional `policy` overrides, required `reason`, optional `traceId`.
- `MemoryConsolidationGroup` — `namespace`, `type`, deterministic `groupKey`, candidate records, `eligible` flag.
- `MemoryConsolidationCandidateResult` — discovery + grouping report (no writes) with all filter counts.
- `MemoryConsolidationEvaluation` — read-only `possible` report without writing.
- `MemoryConsolidationResult` / `MemoryConsolidationStatistics` — created records + deterministic statistics.
- `MemoryConsolidationSourceRef` — safe provenance (id/key/version, never content).

## Pipeline (`consolidate`)

1. **Validate + resolve policy** (fail-closed) — actor, namespace, reason, thresholds; disabled ⇒ no-op.
2. **Discover candidates** — `repository.list(namespace)`; filter by requested type (`types`) + allowed types (`allowedTypes`), exclude already-consolidated artifacts (`source.kind === 'summarization'`), filter lifecycle (Active + not expired).
3. **Authorize each candidate for `Read`** (fail-closed) — denied candidates classified as scope / security / general rejection.
4. **Deterministic grouping** — by `namespace + type + metadata.consolidationGroup`. Group key = stable `namespace ⁄ type ⁄ groupKey`.
5. **Eligibility** — a group consolidates only when it meets `minRecords`.
6. **Cap** — at most `maxRecordsPerOperation` sources per output (deterministic priority order); excess reported in `candidatesExcludedByLimit`.
7. **Authorize the `Write` of the consolidated `LONG_TERM` record** (fail-closed) — throws on denial.
8. **Build the deterministic consolidated record** — `LONG_TERM` type, `source: { kind: 'summarization' }`, provenance metadata, merged priority, merged security, `version: 1`, Active lifecycle, non-destructive.
9. **Create** — idempotency via deterministic key + `MemoryConflictError` handling (a prior identical consolidation is reported as a conflict, not a duplicate).
10. **Emit `MEMORY_CONSOLIDATED`** with safe correlation fields.
11. **Archive opt-in** — only when `archiveSources` is explicitly `true` _and_ the actor is authorized to `Delete` each source.

## Key Design Decisions

1. **Non-destructive by default (prompt §6).** Sources are never mutated, moved, archived, or deleted unless `archiveSources` is _explicitly_ enabled in the supplied policy _and_ the actor is authorized. `recordsPreserved` reports preserved source count.

2. **Deterministic, no LLM (prompt §1, §7).** There is no summarization model. Output content is the best representation: if all source contents are identical the shared content is used; otherwise the highest-priority source content. SSH/summarization text is never fabricated. Provenance is recorded as safe identifiers only.

3. **Consolidated output is a `LONG_TERM` consolidated-summary record (spec §4).** Output `type = LONG_TERM`, `source.kind = 'summarization'`, retention = architecture `annual_consolidation`. This keeps consolidated artifacts distinct from their source type and prevents unbounded re-consolidation (artifacts are excluded from future candidate discovery).

4. **Idempotency (prompt §14, AC-MEM-7).** The output key is a deterministic SHA-256 of the group identity. Re-running consolidation on the same sources hits the same key; `MemoryConflictError` is caught and, when the existing record is a consolidation artifact, reported as an idempotent conflict (no new record, no unbounded growth).

5. **Namespace isolation (prompt §9).** Consolidation is scoped to the request `namespace`. Records in other namespaces are never grouped together or merged.

6. **Authorization at every boundary (prompt §3, §10).** Candidate discovery authorizes `Read` per record; the output write authorizes `Write` on `LONG_TERM`; archive authorizes `Delete` per source. Every check is fail-closed through the injected `AuthorizationService`.

7. **Priority & security preservation (prompt §8).** Output priority = highest source priority; output security level = most sensitive (Confidential if any source is Confidential). Output never downgrades these.

8. **Grouping via existing metadata (prompt §4).** No new identity system. Distinct logical groups of the same type are expressed with the existing `metadata.consolidationGroup` key.

9. **Deterministic statistics (prompt §16).** Candidates discovered / authorized / rejected, filtered by lifecycle / scope / security / type, groups formed / consolidated / skipped, records created / preserved, conflicts, cap exclusions, duration.

## Security Verification

- Candidate access is authorized per record (scope + matrix + security clearance). Confidential sources require a Confidential actor clearance, else they are excluded/filtered.
- Consolidated provenance stores only safe identifiers (id / key / version), never content or metadata.
- No consolidation crosses namespaces. Consolidated records and events carry no secret content (logs use `sanitizeMemoryRecordForLogs`).
- Archiving sources is an explicit, separately-authorized opt-in.

## Backward Compatibility

- Existing AG-001 and AG-002 Sprint 1–5A tests continue to pass (946 total after Sprint 5B).
- No tests deleted, skipped, or weakened.
- No AG-001 files modified; Sprint 5A files are not rewritten.
- No external integrations added (no LLM, embeddings, Qdrant, OpenClaw, Stripe, PostgreSQL, FreelancifyHub, vector DBs).
- No `@ts-ignore` / `@ts-expect-error` / `any` in added source files.
- AG-003, AG-004 are NOT implemented.

## Known Limitations

- `Describe` placeholder — none.
- The 18 typecheck / 27 lint / 2 build errors reported by the quality gates are **pre-existing** in the committed baseline (`retrieval/scorer.ts` unused imports, `token-estimator.ts` inline `import()` type annotations, `retrieval.service.ts` `any`/inline imports, and `retrieval.service.test.ts` test typing). Sprint 5B files introduce zero new errors. These were verified pre-existing by `git diff` (those files are unmodified in this changeset).
