# AG-002 Shared Memory Manager — Sprint 7 Event Log, Audit Trail & Event-Driven Memory Lifecycle

**Agent:** AG-002 · **Scope:** Sprint 7 — Event Log, Audit Trail & Event-Driven Memory Lifecycle · **Status:** Implemented
**Source of truth:** `docs/shared-memory-architecture-v1.md` · **Task:** `prompts/prompts28`

## Summary

Sprint 7 adds an append-only, immutable **event log / audit trail** to AG-002. It records a cadence of lifecycle and access events at a **typed, validated, sanitized, and queryable** boundary, while remaining **additive and non-breaking** to the existing transport-loose `MemoryEvent` model. The sprint delivers: a canonical stored event projection (`StoredMemoryEvent`), strict Zod validation of canonical events, an in-memory `InMemoryEventLog` refining the event lifecycle around deterministic sequence, tokenized pagination with stable event ordering, recursive secret sanitization, by-id lookup, correlation via `traceId`/`requestId`/`correlationId`, and a recorder adapter that funnels live service emissions into the log. No existing AG-001 behavior, persistence contract, or emit site was modified.

Per prompt §31, **this sprint is NOT committed or pushed.** All AG-001 + AG-002 Sprint 1–6 baseline tests continue passing. 64 new Sprint 7 tests are green. Full gates: `npm test` (**1048 passing** = 984 baseline + 64 new), `npm run typecheck` (18 pre-existing errors only), `npm run lint` (27 pre-existing errors only), `npm run build` (2 pre-existing errors only) — no new errors introduced.

## Deliverables

| Area        | Files                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Event model | `events/model.ts` — `StoredMemoryEvent` (canonical `eventId`, `eventType` alias, `timestamp`, `sequence`, `severity`, `category`, `source` + all `MemoryEvent` fields), `MemoryEventId`, `MemoryEventSource`, `MemoryEventSeverity`, `MemoryEventCategory`, `categoryForType` / `severityForType` / `sourceForType`                                                                   |
| Validation  | `events/validation.ts` — Zod `MemoryEventInputSchema`, `validateMemoryEvent` → `MemoryEventValidationError`, `resolveEventLimit`, `eventIdSchema`, `eventTimestampSchema`, `eventTypeSchema`                                                                                                                                                                                          |
| Query       | `events/query.ts` — `EventLogFilter`, `EventLogQuery`, `EventLogPage`, `encodeEventCursor` / `decodeEventCursor` (base64url `{s,e}`), `eventMatchesFilter`, `compareStoredEvents`, `eventAfterCursor`, `INVALID_EVENT_CURSOR`                                                                                                                                                         |
| Sanitize    | `events/sanitize.ts` — `sanitizeEventMetadata`, `metadataContainsSecret`, `sanitizeEvent`; `utils/sanitize.ts` extended with `isSecretKeyName`, `redactSecrets` (case-insensitive, recursive, non-mutating → `[REDACTED]`), `isSecretValue`                                                                                                                                           |
| Log         | `events/log.ts` — `EventLogContract`, `EventLogCapability`/`EventLogCapabilities` (append, appendBatch, query, pagination, getById, immutable, sanitize), `EventLogHealth`, `EventLogMetrics` (appended/rejected/queried/appendDurationMs/queryDurationMs/validationFailures/sanitized/typeCounts), `EventLogOptions`, `InMemoryEventLog`, `createEventLog`, `createEventLogRecorder` |
| Errors      | `errors/index.ts` — `MemoryEventValidationError`, `MemoryDuplicateEventError`, `MemoryEventNotFoundError`, `MemoryUnsupportedOperationError`                                                                                                                                                                                                                                          |
| Config      | `config/schema.ts` — `MEMORY_EVENT_LOG_ENABLED` (default `true`), `MEMORY_EVENT_LOG_MAX_PAGE_SIZE` (default `50`), `MEMORY_EVENT_LOG_MAX_BATCH_SIZE` (default `100`) + constants                                                                                                                                                                                                      |
| Extension   | `events/index.ts` — `MemoryEvent` extended **additively** with `eventId?`, `timestamp?`, `requestId?`, `correlationId?`, `organizationId?`, `workspaceId?`, `projectId?`, `source?`, `service?`, `severity?`, `category?`, `metadata?`; new type re-exports `model` / `validation` / `query` / `log` / `sanitize`                                                                     |
| Tests       | `tests/unit/agents/ag-002-memory-manager/event-log.test.ts` — 64 tests (Sprint 7) covering model, fundamentals, immutability, ordering, filters, pagination, sanitization, integration via `createTestEnv` + recorder + real service ops, correlation, and a 2000-event stress case                                                                                                   |
| Docs        | `docs/ag-002-memory-manager-sprint7-v1.md` — this document                                                                                                                                                                                                                                                                                                                            |

## Sprint 7 Contracts

- `StoredMemoryEvent` — the canonical audit row. `eventId` (default `evt_<uuid>`), `eventType` alias of the lifecycle `type`, `timestamp` (defaults to clock now), and a per-log **monotonic `sequence`** (via the `clock`'s microstep counter) give every event a stable identity and global-order key.
- `EventLogContract` — `append`, `appendBatch`, `query`, `page`, `getById`, `count`, `latest`, `capabilities`, `health`, `metrics`. Every returned event is `deepFreeze`-d (structural immutability) and never mutated by the log.
- `InMemoryEventLog` — first-in-first-out append; canonical events validated by Zod before hosting; sanitized at the boundary when enabled; rejects malformed events with `MemoryEventValidationError`; rejects duplicate `eventId` with `MemoryDuplicateEventError`; by-id misses with `MemoryEventNotFoundError`; batch capped at `maxBatchSize` with `MemoryUnsupportedOperationError` beyond.
- `EventLogQuery` — filter by any of `type`/`eventTypes`, `memoryId`, `actorId`, `organizationId`, `workspaceId`, `projectId`, `traceId`, `requestId`, `correlationId`, `severity`, `category`, `from`/`to` (ISO timestamps), `version`, `lifecycleState`; ordered by `sequence` then `eventId`; limited by `maxPageSize`.
- Cursor pagination — `encodeEventCursor`/`decodeEventCursor` encode a `{ sequence, eventId }` tuple as base64url JSON; resumption is strictly after the tuple (`eventAfterCursor`), so ordering stays stable and pages never overlap or skip. Malformed cursors fail closed with `INVALID_EVENT_CURSOR`.
- Correlation — `traceId`, `requestId`, and `correlationId` (plus org/workspace/project scoping) pass through from loose transport events so a full audit trail can be reconstructed for any request or lifecycle span.
- Recursive sanitization — `redactSecrets` walks nested objects/arrays, redacting any secret-keyed or secret-valued field (case-insensitive key variants like `api_key` / `Api-Key`, bearer tokens, passwords, etc.) to `[REDACTED]`, without mutating the source. Sanitization is applied by default and can be disabled via `EventLogOptions.sanitize`.
- `createEventLogRecorder(log)` — returns `(event) => void`; services can route their existing emissions to `.append`, wiring the event lifecycle into the durable audit trail without changing emit sites.

## Event Model & Ordering Design

1. `host(event)` normalizes a loose `MemoryEvent` into a canonical `StoredMemoryEvent`: resolves `eventId`/`timestamp`, derives `severity`/`category`/`source` via `*ForType`, detects and redacts secrets in `metadata`, and assigns the next monotonic `sequence`.
2. `append`/`appendBatch` advance the sequence counter exactly once per hosted event (batch assigns contiguous sequences), keeping global order identical to insertion order.
3. Query sorting uses `compareStoredEvents` (sequence then eventId), so even with non-monotonic clocks or batch inserts, the audit trail renders in insertion order.

## Constants

- `DEFAULT_MEMORY_EVENT_LOG_ENABLED = true`
- `DEFAULT_MEMORY_EVENT_LOG_MAX_PAGE_SIZE = 50`
- `DEFAULT_MEMORY_EVENT_LOG_MAX_BATCH_SIZE = 100`

## Security Verification

- Event `metadata` (the only free-form surface) is recursively sanitized by default; nested `apiKey`/token/password keys and values are `[REDACTED]`, tested down several levels.
- `EventLogMetrics` carry only aggregate counters and never log content; `EventLogHealth` exposes counts and status only.
- Malformed or foreign pagination cursors are rejected fail-closed with `INVALID_EVENT_CURSOR`; malformed canonical events are rejected before hosting.
- Duplicate event IDs and unknown event types are rejected rather than silently accepted (fail-closed auditing).
- No AG-003/AG-004 behavior, no external DB/persistence, no network I/O, no embeddings/vector store was added. `MemoryEvent` was extended additively only (new optional fields + types); existing emit paths and `events.test.ts` are untouched.

## Backward Compatibility

- Existing AG-001 and AG-002 Sprint 1–6 tests continue to pass (1048 total after Sprint 7, including the 64 new tests).
- No tests deleted, skipped, or weakened; baseline gates (18 typecheck / 27 lint / 2 build errors) unchanged and confirmed.
- No AG-001 files modified; Sprint 1–6 files are not rewritten.
- The `MemoryEvent` transport shape gained only optional additive fields — existing consumers compile and behave identically.
- The architecture does not define a `MEMORY_RESTORED` operation; the archive→restore transition in the event-driven lifecycle is deferred/documented rather than invented (per spec §27).
- No commit or push was performed (prompt §31).
