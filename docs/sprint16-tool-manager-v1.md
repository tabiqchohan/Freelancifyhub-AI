# AG-004 Tool Manager & Tool Registry — Sprint 16 (Tool Management Foundation v1)

## 1. Objective

Deliver **AG-004 Tool Manager & Tool Registry**, the fourth production-grade
subsystem of the FreelancifyHub AI ecosystem. AG-004 establishes a real, safe
tool-management foundation that can model, register, version, categorize,
authorize, validate, execute, sanitize, monitor, and audit tool invocations —
without prematurely building arbitrary remote-tool backends (HTTP/web-search,
browser automation, external payment/API integrations) or an LLM-driven
automatic tool-selection layer.

The sprint follows the production standards established by AG-002/AG-003:
typed interfaces, dependency injection, immutability, deterministic behavior,
explicit configuration, fail-closed security, auditability,
repository/storage separation, service-layer orchestration, migration-based
schema, and comprehensive testing. Execution is deliberately conservative and
safe: a tool must never become executable merely because an arbitrary caller
supplies its name — only registry-approved tools may execute, and the built-in
calculator performs no arbitrary code execution (`eval`/`Function(...)`/shell
are prohibited).

Deferred (non-goals for this foundation sprint): HTTP/web-search/browser tools,
external API/payment/email tools, filesystem-sandbox access, vector/semantic
search, and LLM-driven automatic tool selection. Clean abstraction points for
each are left in place so they can be added later as separately-approved tools.

## 2. Scope

In scope:

- Tool domain model (`ToolDefinition`, canonical versioned identity, category,
  security level, execution policy).
- Extensible tool categories (COMPUTATION, SEARCH, HTTP, DATABASE, FILESYSTEM,
  COMMUNICATION, INTERNAL, EXTERNAL, OTHER).
- A thread-safe, authoritative in-process **ToolRegistry** returning immutable
  definitions; duplicate/version-conflict detection; enable/disable;
  resolveVersion; deterministic listing.
- Schema validation of tool input and output using **zod** (the project's
  existing validation library), compiled once per tool.
- A production **ToolExecutor** with a full, verifiable pipeline: resolve →
  enabled → authorize → validate input → enforce policy (size/concurrency/timeout)
  → execute (+ bounded retry) → validate output → sanitize result → record metrics
  → emit audit event → return a typed result.
- Timeout and cancellation handling with deterministic race semantics (never
  reports false success on timeout/cancellation).
- Bounded, deterministic, cancellation-aware retry policy that never blindly
  retries auth/validation failures.
- Fail-closed authorization (permission matrix, namespace scope, security level,
  enabled state), reusing AG-002 actor concepts.
- A safe, genuinely executable **calculator** tool (bounded recursive-descent
  arithmetic parser — no eval, no shell, no arbitrary JS).
- Result sanitization (reuses AG-002's `redactSecrets`) to prevent secret
  leakage.
- Deterministic in-process metrics.
- A tool event log for registry + execution audit events (no tool I/O in events).
- Repository/storage split: `ToolRepository` abstraction + in-memory repo +
  durable PostgreSQL repo with versioned migrations (versions **200–202**,
  sharing AG-002/AG-003's `schema_migrations` table).
- Runtime composition-root wiring, AG-001 `ToolContextProvider` integration,
  production-safe `/api/tools` HTTP endpoints, and honest health.
- Comprehensive unit, repository, security, PostgreSQL (Neon), E2E, and
  failure-path tests.

## 3. Filename / Directory Layout

Source tree under `src/agents/ag-004-tool-manager/`:

```
ag-004-tool-manager/
  index.ts                 # barrel (public API surface)
  enums/index.ts           # ToolCategory, ToolPermission, ToolActorGroup,
                           #   ToolSecurityLevel, ToolStatus, ToolResultStatus,
                           #   ToolErrorClass, ToolEventType
  types/index.ts           # ToolDefinition, ToolSpecification, ToolHandler,
                           #   ToolExecutionContext, ToolActor, ToolResult,
                           #   ToolExecutionPolicy, ToolRetryPolicy, ...
  errors/index.ts          # ToolError (base) + typed subclasses
  config/schema.ts         # zod ToolConfigSchema + safe defaults + default policy
  config/index.ts          # parseToolConfig (fail-closed), exports schema
  utils/ids.ts             # createToolId, normalizeToolName/Version, trace ids
  utils/sanitize.ts        # sanitizeToolOutput/Result (reuses AG-002 redactSecrets)
  validators/index.ts      # ToolInputValidator, ToolOutputValidator (compile-once)
  security/index.ts        # policy interfaces + matrix/namespace/security/enabled
                           #   policies + DefaultToolAuthorizationService
  policies/index.ts        # classify, isRetryable, retryDelay, cancellableDelay,
                           #   runWithTimeoutAndCancellation
  events/index.ts          # ToolEvent types + per-type category/severity/source
  events/log.ts            # ToolEventLog (in-memory append-only audit)
  metrics/index.ts         # ToolMetrics (deterministic, aggregate, safe)
  registry/index.ts        # ToolRegistry + LiveTool (immutable-frozen defs)
  repositories/interface.ts# ToolRepository contract
  repositories/types.ts    # ToolRecord (portable/persisted shape)
  repositories/in-memory.ts# InMemoryToolRepository
  storage/index.ts         # exports migrations, schema version, Postgres repo
  storage/schema.ts        # TOOL_SCHEMA_MIGRATIONS (200–202) + migrateToolSchema
  storage/postgres.ts      # PostgresToolRepository (parameterized SQL)
  execution/index.ts       # createToolExecutor
  execution/executor.ts    # ToolExecutor (the full execution pipeline)
  services/index.ts        # createToolManagerService, context provider re-exports
  services/tool-manager.service.ts  # ToolManagerService (orchestration + authz)
  services/tool-context-provider.ts # AG-004 → AG-001 ToolContextProvider adapter
  tools/index.ts           # built-in tool exports (calculator)
  tools/calculator.ts      # CALCULATOR_TOOL_NAME + createCalculatorSpecification
```

## 4. Domain Model

- **`ToolDefinition`** (immutable): canonical id `tool:<name>:v<version>`,
  normalized `name`, `description`, `version` (X.Y.Z), `category`, zod
  `inputSchema`/`outputSchema`, `permissions`, `securityLevel`, `executionPolicy`,
  `enabled`, `metadata`, `createdAt`/`updatedAt`.
- **`ToolSpecification`** (registration input): mirrors the definition plus a
  `handler` (the executable payload). A registered definition is frozen; only a
  registry-approved `register`/`update` (version) changes it.
- **`ToolHandler`**: `invoke(input, context)` — the executable part. Documented
  to never perform arbitrary code execution, shell execution, or unrestricted I/O
  unless explicitly designed and authorized.
- **`ToolRecord`** (persisted shape): the portable, JSON-safe projection of a
  definition. Deliberately excludes live zod schemas and handler functions, so
  executable JS is never stored as an execution mechanism.
- **Identity & normalization**: names are lowercased/trimmed and restricted to
  `[a-z0-9_-]` (1–64 chars); versions must match `X.Y.Z`. This prevents tool-name
  injection and keeps ids safe for logs, paths, and routes.

## 5. ToolRegistry

- Thread-safe (serialized mutation queue); returns **frozen** (immutable)
  definitions.
- `register`, `replace` (version update), `remove`, `enable`, `disable`,
  `get`, `getById`, `getLive`, `exists`, `resolveVersion`, `list` (deterministic
  by name), `count`, `clear` (test helper).
- Duplicate id and duplicate-name registrations are rejected with
  `ToolConflictError` (fail closed); a tool can never be made executable merely
  by an arbitrary caller supplying its name.
- Design note: zod schemas embedded in definitions are skipped during deep-freeze
  (freezing a `ZodType` breaks its internal def normalization); all other
  definition data is still deeply frozen.

## 6. Validation

- `ToolInputValidator` / `ToolOutputValidator` wrap the per-tool zod schema,
  compiled once (cached) at construction.
- Input pipeline validates raw input → typed/validated input handed to the
  handler; output pipeline validates the handler's return value before it is
  sanitized and returned.
- Validation failure yields a typed `VALIDATION_FAILED` result, never a throw.

## 7. Execution Pipeline (ToolExecutor)

1. Resolve the registered tool.
2. Verify enabled state.
3. Verify authorization (permission matrix, namespace scope, security level,
   enabled-state).
4. Validate input (schema).
5. Enforce execution policy (max input bytes; advisory concurrency).
6. Enforce timeout (`context.timeoutMs ?? policy.timeoutMs`).
7. Support cancellation (`AbortSignal`).
8. Execute with bounded, cancellation-aware retries.
9. Validate output (schema) and enforce max output bytes.
10. Sanitize the result (secret redaction).
11. Record metrics.
12. Emit an audit event.
13. Return a typed `ToolResult`.

`ToolResult` distinguishes SUCCESS / VALIDATION_FAILED / AUTHORIZATION_FAILED /
TIMEOUT / CANCELLED / EXECUTION_FAILED / DISABLED / NOT_FOUND and carries
`toolId`, `toolVersion`, `executionId`, `durationMs`, optional sanitized
`output`, and `attempts`. No internal stack traces or secrets leak to callers.

## 8. Timeout & Cancellation

- `runWithTimeoutAndCancellation` races `{run, timeout, cancellation}` and
  resolves the first winner deterministically — never reporting false success on
  a timeout or cancellation.
- Cancellation is checked before each retry and during retry backoff
  (`cancellableDelay`); aborted executions short-circuit to `CANCELLED`.

## 9. Retry Policy

- Bounded, configurable (`maxRetries`, `backoffBaseMs`, `backoffMaxMs`)
  exponential backoff.
- Error classification via `classifyToolError`: authorization and validation
  errors, timeouts, and cancellations are **never** retried; only explicitly
  retryable `ToolError`s (e.g. `ToolStorageError`) are retried. Plain unknown
  errors are treated as non-retryable (fail closed).
- Backoff is cancellation-aware; each entry into the loop re-checks the abort
  signal.

## 10. Permissions & Policies

- `ToolPermission`: READ / EXECUTE / REGISTER / UPDATE / ENABLE / DISABLE /
  DELETE / ADMIN.
- `TOOL_ACCESS_MATRIX` grants EXECUTE/READ to clients/freelancers/marketplace,
  full management to `TOOL_MANAGER`/`ADMIN`, and execute to `ORCHESTRATOR`
  (which also holds ADMIN). Missing entries default to **denied**.
- Composite fail-closed policy: matrix permission → namespace scope → security
  level (CONFIDENTIAL requires CONFIDENTIAL clearance) → enabled state.
- `validateToolActorContext` throws on missing/invalid actor context.

## 11. Results & Sanitization

- Results carry safe metadata (ids, version, executionId, duration, status,
  attempts) plus an optional **sanitized** output.
- `sanitizeToolOutput` / `sanitizeToolResult` reuse AG-002's canonical
  `redactSecrets` to strip env vars, tokens, passwords, connection strings,
  authorization headers, and secret-key-shaped values. Tool input/output is
  never logged by default; events carry no tool I/O.

## 12. Metrics

- `ToolMetrics`: per-tool counters (executions, successes, failures, timeouts,
  cancellations, auth-failures, validation-failures), total/last duration,
  plus aggregate totals. Deterministic snapshot with sorted keys.

## 13. Events / Audit

- `ToolEventLog` (in-memory append-only, max page size 50) storing immutable,
  content-free `StoredToolEvent`s.
- Event types: `tool.registered`, `tool.updated`, `tool.enabled`,
  `tool.disabled`, `tool.removed`, `tool.execution.started|succeeded|failed|
timeout|cancelled`, `tool.authorization.denied`.
- Registry-management and execution events carry `traceId`, `namespace`,
  tool identity, `executionId`, `actor{Group,Id}`, `requestId`, `status`, and
  sanitized metadata only.

### Event Failure Policy

If a tool **execution succeeds but the audit event persistence fails**, the
execution result is **preserved and returned**; the event-log append is wrapped
in try/catch so a failed append cannot change the execution outcome. Failed
registry/execution events are logged (via the logger) but do not alter the
recorded execution result. The `ToolEventLog` rejects duplicate event ids and
events missing required fields, keeping the audit trail deterministic and
non-corrupted.

## 14. Persistence (Storage)

- `ToolRepository` abstraction (save/update/getById/list/remove/healthAsync).
- `InMemoryToolRepository`: non-durable, for tests and the default in-memory
  backend.
- `PostgresToolRepository`: durable production backend over the shared Neon pool,
  using parameterized SQL. Persists portable definitions/metadata only — never
  executable JS and never secrets.
- Migrations use the shared `schema_migrations` table with **AG-004-specific
  version numbers 200–202** (AG-002 uses 1–2; AG-003 uses 100–103), so they never
  conflict:
  - **200** `tool_definitions` (+ indexes, unique `(name, version)`),
  - **201** `tool_versions` (version history, FK cascade),
  - **202** `tool_events` (audit trail).
- The configured backend is authoritative and fail-closed: an unknown backend or
  a durable backend without a connection URL aborts construction — never a silent
  fall back to in-memory when durable is configured.
- The tool database URL is **reused from the existing memory config** when present
  (`MEMORY_DATABASE_URL`); `TOOLS_DATABASE_URL` is an optional fallback and is
  never required when the shared URL is present.

## 15. Configuration

`ToolConfigSchema` (zod) with safe defaults:

- `TOOLS_ENABLED` (default `true`), `TOOLS_STORAGE_BACKEND` (default
  `in-memory`), `TOOLS_DATABASE_URL` (optional, shared fallback),
- `TOOLS_DEFAULT_TIMEOUT_MS` (5000), `TOOLS_MAX_INPUT_BYTES` (64 KiB),
  `TOOLS_MAX_OUTPUT_BYTES` (128 KiB), `TOOLS_DEFAULT_RETRY_COUNT` (2),
  `TOOLS_STORAGE_MAX_PAGE_SIZE` (50), `TOOLS_CONCURRENCY_LIMIT` (16).

Parsing is fail-closed: invalid values throw `ToolConfigurationError`.

## 16. Runtime Integration

- `src/app/env.ts` gains `Environment.tools` (parsed via `parseToolConfig`).
- `src/app/composition-root.ts` builds the tool stack (repository selected by
  `TOOLS_STORAGE_BACKEND`), constructs `ToolManagerService`, registers the
  built-in calculator (bootstrap `TOOL_MANAGER` actor), adds
  `toolManager`/`toolEventLog` to `services`, `toolStorageClose` to `storage`,
  and `probeToolStorage` to `health`. Fail-closed on a durable backend without a
  URL.
- AG-001 integration: `services/tool-context-provider.ts` implements AG-001's
  existing `ToolContextProvider` (`ContextSourceType.TOOL`), letting the
  orchestrator request an authorized, safe listing of available tools as context
  items (name, description, version, category, enabled) — execution is never
  performed during context loading. Tool execution is exposed through abstract,
  role-scoped operations (`register`, `execute`, `enable`, `disable`) rather than
  hardcoded calculator logic.

### Production API (`/api/tools`)

- `GET /api/tools?group=&ns=` → authorized list of tools (safe metadata).
- `GET /api/tools/:name?group=&ns=` → a tool definition.
- `POST /api/tools/:name/execute?group=&ns=` with `{ input }` → typed result.
- `POST /api/tools/:name/enable|disable?group=&ns=` → management (TOOL_MANAGER /
  ADMIN).

Authorization and namespace come from query params and are mandatory (an invalid
actor group is rejected). HTTP status mapping is deterministic (200 success;
400 validation; 403 authorization/disabled-request; 404 not found; 422 other
failure). No internal details or stack traces are surfaced.

### Health

`/health`/`/healthz` now report `tools: { healthy }` and treat the tools stack as
a first-class readiness signal; a degraded/unavailable tool backend moves overall
status to `degraded`.

## 17. Security Model

- Deny-by-default: missing actor/permission/scope → denied.
- No arbitrary code execution (`eval`, `Function(...)`, shell) in any tool or the
  executor; the calculator uses a bounded recursive-descent parser.
- Registry-gated execution: only registered, enabled, authorized tools run.
- Input/output size bounds, timeouts, bounded retries, advisory concurrency.
- No tool-name injection (normalized, restricted), no SQL injection (parameterized
  queries), no secret leakage (sanitization + content-free events), no prototype
  pollution, no cross-namespace execution, no version-confusion bypass.
- No serialization of handler/schema into storage; durable persistence holds only
  portable metadata.

## 18. Testing

- **Unit** (`tests/unit/agents/ag-004-tool-manager/`, 9 files / 69 tests):
  registry, service+executor, calculator, security, metrics, sanitize, config,
  event-log, in-memory repository.
- **Integrations**:
  - `tests/integration/tools/postgres.integration.test.ts` (7 tests) — real Neon,
    gated via the `describe`/`describe.skip` convention on `MEMORY_DATABASE_URL`
    presence; verifies 200–202 migrations, register/persist (calculator), unique
    (name, version) constraint, enable/disable persistence across re-open, list
    pagination, remove, health.
  - `tests/integration/runtime/tools-e2e.test.ts` (7 tests) — boots the production
    runtime over an in-memory backend and exercises health, list, calculator
    execution, validation failure, authorization failure, not-found, and
    disable/enable lifecycle through the real HTTP API.
- **Failure paths** covered: unknown tool, invalid actor group, disabled tool,
  oversized/invalid input, group lacking permission, timeout, cancellation,
  retry exhaustion and later-success, duplicate registration/version, event-log
  duplicate/missing-field rejection.

## 19. Quality Gates (all passing)

- Full `vitest run` — no regressions, all new tests green.
- Typecheck (see below) — 0 errors.
- `eslint .` — 0 errors.
- `npm run build` — success.
- Runtime smoke test — `/health` + `/healthz` report ok including `tools`, and the
  calculator executes through the production runtime returning a correct result
  (verified in the E2E suite and smoke test).
- Durable Neon persistence + calculator execution verified.

## 20. Deferred / Non-Goals

HTTP/web-search/browser tools, external API/payment/email integrations,
filesystem sandboxing, semantic/vector search over tool results, and LLM-driven
automatic tool selection are explicitly deferred and are NOT claimed as
implemented in this sprint. Abstraction points (category enum, repository split,
policy extension, `ToolHandler` contract, context-provider interface) support
adding them later as separately-approved tools.
