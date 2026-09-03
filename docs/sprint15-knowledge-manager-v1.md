# AG-003 Knowledge Manager — Sprint 15 (Knowledge Management Foundation v1)

## 1. Objective

Deliver **AG-003 Knowledge Manager**, the third production-grade subsystem of the
FreelancifyHub AI ecosystem. AG-003 establishes a real knowledge-management
foundation that can ingest, represent, normalize, chunk, version, lifecycle,
authorize, persist (durable Neon PostgreSQL), retrieve, rank, deduplicate, and
expose knowledge for grounding agent answers — without prematurely building an
LLM/vector/embedding provider.

The sprint follows the same production standards established by AG-002: typed
interfaces, dependency injection, immutable domain objects, deterministic
behavior, explicit configuration, fail-closed security, lifecycle/version-aware
operations, auditability, repository/storage separation, service-layer
orchestration, migration-based schema, and comprehensive testing.

Deferred (non-goals for this foundation sprint): semantic/vector retrieval,
external embeddings, LLM summarization, and web crawling. A clean abstraction
(left in the retrieval pipeline) supports adding semantic chunking/retrieval
later.

## 2. Scope

In scope:

- Knowledge domain model (`KnowledgeDocument`, typed source, metadata, checksum).
- Deterministic normalization.
- Deterministic chunking engine (Document → Version → Chunk).
- Immutable versioning with deterministic version numbers.
- Explicit lifecycle states (ACTIVE / ARCHIVED / EXPIRED / DELETED).
- Fail-closed authorization & security (reuses AG-002 conventions).
- Repository abstraction + PostgreSQL durable storage + versioned migrations.
- Deterministic retrieval/scoring/ranking/deduplication/limits/budget.
- `KnowledgeContextBuilder` → AG-001-compatible context.
- Event/audit system riding the existing AG-002 log infrastructure.
- AG-001 integration (`KnowledgeContextProvider`).
- Sprint-14 runtime composition-root wiring + production-safe knowledge API +
  honest health/capabilities.

Out of scope / deferred (documented, not fabricated): semantic chunking, vector
embeddings, external web crawling, LLM generation.

## 3. Architecture

AG-003 lives under `src/agents/ag-003-knowledge-manager/`, mirroring AG-002's
layering (`types`, `enums`, `errors`, `config`, `utils`, `clock`, `validators`,
`lifecycle`, `security`, `storage`, `repositories`, `retrieval`, `chunking`,
`versioning`, `normalization`, `events`, `services`, `index.ts` barrel).

The runtime wiring is assembled exclusively in the Sprint-14 production
composition root (`src/app/composition-root.ts`) — there is no hidden global
initialization. `env.knowledge` (parsed in `src/app/env.ts` via
`parseKnowledgeConfig`) drives backend selection; construction is fail-closed on
an unknown/invalid backend or a missing durable connection string.

## 4. Domain model

Core entities (`types/index.ts`):

- **`KnowledgeDocument`** — id (`knowledge_<uuid>`), namespace/scope, title,
  content, contentType (plain_text / markdown / json / html), typed source
  metadata, metadata, lifecycle, securityLevel (INTERNAL / CONFIDENTIAL), current
  `version` (starts at 1), deterministic `contentHash` (SHA-256 hex),
  `createdAt`/`updatedAt`, `createdBy`/`updatedBy`, `traceId`.
- **`KnowledgeSourceMetadata`** — `sourceType` (manual_text / markdown /
  document / url_reference / application_generated / system) plus optional
  `reference`, `author`, `url`, `version`. Extensible via string values.
- **`KnowledgeVersion`** — immutable snapshot bound to a document with a stable
  `versionNumber`, content hash, author, and timestamps.
- **`KnowledgeChunk`** — `chunkId`, `documentId`, `versionId`, `versionNumber`,
  `chunkIndex`, content, content hash, inherited metadata, `createdAt`.
- **`KnowledgeRetrievalResult`** — returned to consumers with document/version/
  chunk references, source, `score`, and `scoreExplanations` (explainable).

ID/timestamp conventions reuse AG-002 `utils/ids.ts` (createTraceId,
createRequestId, nowIso) plus new `createKnowledgeId`, `createKnowledgeVersionId`,
`createChunkId`.

## 5. Ingestion & normalization

`normalization/index.ts` implements deterministic normalization: whitespace,
newline, and encoding-safe handling; empty-content rejection; normalization of
title / source / namespace / metadata. The same input always produces the same
normalized output. Edge cases covered by tests: empty content, whitespace-only,
very large content, Unicode, duplicate whitespace, newline variants, malformed
metadata, missing title, duplicate content.

Checksums (`utils/checksum.ts`) are deterministic SHA-256 hex digests of the
normalized content.

## 6. Chunking

`chunking/index.ts` is a deterministic chunking engine with configurable maximum
chunk size and overlap. Each chunk has a deterministic chunk ID, a stable
`chunkIndex`, source-document reference, inherited metadata, and a content hash.
Edge cases covered: small, exact-boundary, large, empty, Unicode, overlap, and
last-partial chunks. The chunker is current-content-based (lexical, whitespace /
size) with a clean abstraction so a semantic chunker can be added later — it does
not claim to be semantic.

## 7. Versioning

`versioning/index.ts` manages immutable historical versions. `createInitialVersion`
produces version 1; `createNewVersion` produces the next monotonic version. The
document's `version` field points at the active/current version; historical
versions are never overwritten (enforced by a `UNIQUE (document_id, version_number)`
constraint in Postgres and repository checks in-memory). Retrieval is
version-aware (current or explicit version). Invalid transitions are rejected.

## 8. Lifecycle

`lifecycle/index.ts` exposes `KnowledgeLifecycleState`: ACTIVE, ARCHIVED, EXPIRED,
DELETED. Valid transitions:

- ACTIVE → ARCHIVED, ACTIVE → EXPIRED
- ARCHIVED → ACTIVE (restore), ARCHIVED → EXPIRED
- EXPIRED → DELETED (erase, per policy)

A `DefaultKnowledgeLifecycle` enforces transitions; operations fail-closed on
invalid transitions. Normal retrieval excludes ARCHIVED/EXPIRED/DELETED documents
unless explicitly requested with authorization.

## 9. Authorization & security

`security/index.ts` reuses AG-002 authorization conventions (`MemoryActor`,
policies, `createAuthorizationService` pattern) under a knowledge-specific
facade. It distinguishes read / create / update-version / archive / restore /
expire / delete-erase / lifecycle-manage. Policies compose fail-closed:
matrix permission (`KNOWLEDGE_ACCESS_MATRIX`), namespace scope, security level
(INTERNAL vs CONFIDENTIAL), owner, and lifecycle access. `validateKnowledgeActorContext`
rejects missing/malformed actors. Authorization always happens **before**
protected content is exposed — never returns unauthorized knowledge just because
it matched retrieval criteria. Canonical redaction/dedup keeps content out of
audit events where the security architecture requires it.

## 10. Repository abstraction

`repositories/index.ts` and `services/knowledge.service.ts` define `KnowledgeRepository`
with: save/create, get by id, get current version, get explicit version, list
(deterministic pagination), version creation, delete/erase, lifecycle update, chunk
retrieval, and metadata retrieval. Pagination uses offset/limit with a fixed sort
key (default `created_at`). `InMemoryKnowledgeRepository` is test/observability
infrastructure; `PostgresKnowledgeRepository` is the production durable
implementation.

## 11. PostgreSQL durable storage

`storage/postgres.ts` implements `PostgresKnowledgeRepository` backed by a real
`pg.Pool` with parameterized SQL (no string concatenation of user input).
`storage/schema.ts` defines the versioned migration set and a
`migrateKnowledgeSchema` runner. It shares the existing `schema_migrations`
table with AG-002 but uses distinct version numbers (100–103) to avoid conflicts
(AG-002 uses 1–2).

Schema (`knowledge_documents`, `knowledge_versions`, `knowledge_chunks`,
`knowledge_events`):

- Proper PKs, FKs with `ON DELETE CASCADE`, uniqueness constraints, version
  constraints (`version >= 1`, `chunk_index >= 0`), and useful indexes
  (namespace, lifecycle, security_level, content_hash, created_at/updated_at;
  `UNIQUE (namespace, title)`, `UNIQUE (version_id, chunk_index)`,
  `UNIQUE (document_id, version_number)`).
- Transaction safety: migrations run inside BEGIN/COMMIT with
  ROLLBACK on failure (idempotent across restart).
- Deterministic ordering for listing/retrieval.
- Durable restart persistence: when the durable backend is selected, successful
  writes are confirmed via PostgreSQL. There is **no silent fallback to
  in-memory** when durable is configured — construction fails closed if the
  connection string is missing or the pool cannot be established.

`KNOWLEDGE_DATABASE_URL` is the (optional-by-default, mandatory-when-durable)
Neon connection string; it is never logged or surfaced in errors/health/events.

## 12. Retrieval engine

`retrieval/index.ts` implements deterministic, explainable retrieval. The
pipeline (matching the spec) is:

```
candidate retrieval
→ lifecycle filtering
→ authorization filtering
→ namespace/scope filtering
→ security filtering
→ relevance scoring
→ ranking
→ deduplication
→ version selection
→ limits
→ context budget
→ response
```

The baseline scorer (`scoreDocument`) is lexical: title match, metadata match,
exact token match, normalized-content match, source priority, and version
recency. Each `KnowledgeRetrievalResult` carries `score` and `scoreExplanations`
(signal + contribution + detail) so ranking is explainable (no random scoring).
The architecture reserves a seam for future vector/semantic retrieval but does
not claim it is implemented.

## 13. Context builder & AG-001 integration

`services/context-builder.ts` (`buildKnowledgeContext`) converts retrieved
knowledge into AG-001-compatible context items: priority-aware selection, token/
size budget, deduplication, metadata preservation, source attribution, and
document/version/chunk references. It reuses AG-001 shared abstractions rather
than duplicating AG-002's MemoryContextBuilder.

`src/agents/ag-001-master-orchestrator/context/knowledge/knowledge-context-provider.ts`
provides `KnowledgeContextProviderAdapter` implementing the AG-001
`KnowledgeContextProvider` interface (`ContextSourceType.KNOWLEDGE`), exposed
through the AG-001 context barrel (`createKnowledgeContextProvider`). This lets
AG-001 request knowledge context through a clean interface while keeping
retrieval independently testable and without disturbing the AG-002 memory flow.

## 14. Event / audit system

`events/` mirrors AG-002's event-log conventions. `KnowledgeEventLog` /
`createKnowledgeEventLog` persist canonical `StoredKnowledgeEvent`s
(event id, monotonic sequence, timestamp, actor, namespace, entity id, operation,
correlation/causation id, metadata). Event types: KNOWLEDGE_CREATED,
KNOWLEDGE_VERSION_CREATED, KNOWLEDGE_UPDATED, KNOWLEDGE_ARCHIVED,
KNOWLEDGE_RESTORED, KNOWLEDGE_EXPIRED, KNOWLEDGE_DELETED, KNOWLEDGE_RETRIEVED,
KNOWLEDGE_ACCESS_DENIED. Category/severity/source are derived deterministically
per type. Sensitive knowledge content is not embedded in audit events.

## 15. Runtime integration

`src/app/composition-root.ts` wires AG-003 with dependency injection:

- `env.knowledge` → `KnowledgeManagerService` (repository, event log, config).
- Backend selection: `KNOWLEDGE_STORAGE_BACKEND` — `durable` (Neon PG) or
  `in-memory` (tests/locale). Durable builds a `PostgresKnowledgeRepository`
  (new pool + migration run) and exposes a close handle; in-memory uses
  `InMemoryKnowledgeRepository`.
- `probeKnowledgeStorage` → honest health reporting; both storage and knowledge
  must be healthy for `/healthz` to report `ok`.
- Graceful shutdown closes the knowledge pool handle.

The runtime boots successfully in the existing configuration; AG-001/AG-002 and
Sprint-14 behavior is preserved.

## 16. Knowledge API

`src/app/runtime.ts` exposes a production-safe knowledge API (typed JSON, input
validation, typed error responses, no stack traces/secret leakage, no
unauthorized content):

- `POST /api/knowledge` — create a knowledge document
- `GET /api/knowledge?query=&ns=&group=` — search authorizable documents
- `GET /api/knowledge/:id` — fetch a document by id

Actor group is resolved from query/body and normalized; unknown values default
closed to a safe group. No unauthorized documents are returned.

## 17. Health & capabilities

`/healthz` and `/health` report `storage` + `knowledge` health and an overall
`ok`/`degraded` status. When the required durable backend is unavailable, the
subsystem reports unhealthy (fails closed). No credentials or connection strings
are surfaced.

## 18. Configuration

`config/schema.ts` (zod): `KNOWLEDGE_MAX_CONTENT_BYTES`, `KNOWLEDGE_MAX_METADATA_KEYS`,
`KNOWLEDGE_MAX_TITLE_LENGTH`, `KNOWLEDGE_RETRIEVAL_MAX_RESULTS`,
`KNOWLEDGE_CHUNK_MAX_SIZE`, `KNOWLEDGE_CHUNK_OVERLAP_SIZE`,
`KNOWLEDGE_CONTEXT_ENABLED`, `KNOWLEDGE_STORAGE_BACKEND`,
`KNOWLEDGE_STORAGE_MAX_PAGE_SIZE`, `KNOWLEDGE_DATABASE_URL`. Safe defaults;
fail-closed when a durable backend is selected without a connection string.

## 19. Databases & migrations

Migrations reuse the shared `schema_migrations` table with AG-003 version
numbers 100–103:

| Version | Name                        | Object                |
| ------- | --------------------------- | --------------------- |
| 100     | `knowledge-documents-table` | `knowledge_documents` |
| 101     | `knowledge-versions-table`  | `knowledge_versions`  |
| 102     | `knowledge-chunks-table`    | `knowledge_chunks`    |
| 103     | `knowledge-events-table`    | `knowledge_events`    |

`migrateKnowledgeSchema` runs pending migrations in ascending order inside
transactions (rollback on failure, idempotent across restart).

## 20. Testing

- **Unit** (`tests/unit/agents/ag-003-knowledge-manager/`): domain models,
  normalization, checksums, chunking, versioning (+ versioning errors), lifecycle
  - security, authorization/matrix behavior, scoring/ranking/deduplication,
    retrieval limits/budget, context builder, repository, event log, config/schema,
    service behavior.
- **Repository** tests: create/read/update/version/delete/pagination/constraints/
  lifecycle/deterministic ordering (in-memory repository tests).
- **PostgreSQL integration** (`tests/integration/knowledge/postgres.integration.test.ts`,
  gated on `MEMORY_DATABASE_URL` via the existing `describe`/`describe.skip`
  convention): durable insert, restart persistence, versions, chunks,
  transactions, rollback, constraints, deletion, lifecycle, retrieval, events.
- **E2E** (`tests/integration/runtime/knowledge-e2e.test.ts`): the 8 scenarios —
  create→normalize→persist→chunk→retrieve→authorized; version 2 with version 1
  immutable; unauthorized denial/redaction; archive excludes from normal
  retrieval; restore makes available; restart durability; retrieval through
  AG-001; runtime event → AG-003 event → durable log.
- **Failure** patterns: malformed input, missing actor, unauthorized actor,
  invalid namespace, invalid lifecycle transition, invalid version, duplicate
  version/document, database unavailable, transaction rollback, malformed
  config, empty/huge content, corrupted data, missing referenced document,
  deleted/archived/expired document — all fail predictably with typed errors.

## 21. Quality gates (Sprint 15)

Verified locally:

- Full test suite: **118 files / 1402 tests passed** (AG-003 tests added on top of
  the Sprint-14 baseline of 105 files / 1307 tests).
- TypeScript typecheck: `node --stack-size=8000 --max-old-space-size=4096
node_modules/typescript/bin/tsc --noEmit` — **0 errors**.
- ESLint: `npx eslint .` — **0 errors**.
- Production build: `npm run build` — **success**.
- Runtime smoke test (built `dist/index.js` boot, `/healthz` + `/health` `ok`,
  `POST /api/knowledge` create, `GET /api/knowledge?query=` search): **success**,
  storage and knowledge healthy, no secret/stack-trace leakage.

## 22. Future vector-search extension points

- Chunking abstraction (`chunking/index.ts`) can accept a semantic segmenter.
- Retrieval `scoreDocument` seam and candidate step can be swapped/switched to a
  vector index producing embedding-based candidates; the downstream
  lifecycle/authorization/scope/security/rank/dedup/limit/budget pipeline is
  unchanged.
- No LLM/embedding provider is wired; none is claimed.

## 23. Deferred work

- Semantic/vector retrieval and embeddings.
- External web crawling for `url_reference` sources (source model supports the
  reference; fetching is not implemented).
- LLM-based summarization / semantic chunking.
- Full DSR-style erasure policy automation beyond lifecycle `DELETED`.
