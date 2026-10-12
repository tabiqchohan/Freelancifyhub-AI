# AI Employee (AG-701) — Production Hardening (Prompts19)

Status: implemented and tested. This document records the production-hardening
work on the AG-701 AI Employee: durable task/artifact storage, an expiry
reaper, an explicit cancellation lifecycle, bounded concurrency with
backpressure, and the execution-sandbox decision. It does not restate the
Prompts17 pipeline (requirements -> plan -> execute -> validate -> package;
see `sprint26-production-ai-operating-system-v1.md` for the surrounding OS).

## 1. Execution sandbox decision (fail-closed, documented blocker)

The AI Employee produces a **static** web bundle only (HTML/CSS/JS assets).
A repository-wide check of `src/agents/employee-ai/**` confirms there is **no
process execution surface**: no `child_process`, no `spawn`/`exec`, no `eval`,
no `vm`, and no generated-code execution. The executor writes files through the
AG-004 tool gateway into a confined workspace and validates the built site by
**parsing** HTML (regex + link checks) — it never runs the generated site.

Consequences:

- No OS-level sandbox (container/VM/gVisor) is required for the current
  capability, because no untrusted code is ever executed on the host.
- Requests that would require executing generated code (React/Next/npm builds,
  node backends, databases, CMS platforms) are **refused up front** with an
  `UNSUPPORTED` scope decision. This is intentional fail-closed behaviour: the
  request is rejected, never executed.
- **Blocker / precondition:** if the capability is ever extended to execute
  generated code, it must first be moved behind a real isolated execution
  environment (e.g. a rootless container with no network, read-only rootfs,
  CPU/memory/time limits, and a per-task ephemeral filesystem). Until that
  exists, arbitrary-execution requests must remain refused. This is the honest
  boundary — the subsystem must not claim sandbox safety it does not have.

## 2. Durable task + artifact storage (Phase 2)

Task state and reviewed ZIP bytes are now persisted via a storage port,
`EmployeeTaskRepository`, with two implementations:

- `InMemoryEmployeeTaskRepository` — development and tests (`durable = false`).
- `PostgresEmployeeTaskRepository` — durable; task rows + artifact bytes.

The `EmployeeService` is **write-through**: accepted tasks are persisted before
they are acknowledged, terminal results and artifact bytes are persisted when
the pipeline finishes, and `hydrate()` rebuilds the bounded in-memory cache on
startup. The in-memory working set is only a bounded cache; when durable, the
database is the source of truth.

- Schema migrations live at **versions 300 and 301** in the shared
  `schema_migrations` table, guarded by the AG-002 advisory lock — they never
  collide with AG-002 (1,2), AG-003 (100+), or AG-004 (200+).
- Artifact bytes are stored as `BYTEA` with `file_name`, `sha256` and
  `size_bytes`; reads fall back to the on-disk workspace file if a durable
  artifact is absent.
- **Restart recovery:** on startup `hydrate()` marks every non-terminal task
  `FAILED` ("interrupted by a restart") so no client ever sees a task stuck
  forever. Terminal tasks are reloaded so their artifacts remain reachable.
  Queued (accepted, not yet running) tasks are not resumed — they are marked
  `FAILED` and the client may retry.

### Backend selection (fail-closed)

`resolveEmployeeStorageBackend(config, NODE_ENV)`:

- `EMPLOYEE_STORAGE_BACKEND=in-memory|durable`; when unset it defaults to
  `durable` in production and `in-memory` otherwise.
- An explicit `in-memory` in production **throws** at startup — state and
  artifacts can never silently reside only in RAM.
- The durable connection string is `EMPLOYEE_DATABASE_URL`, falling back to the
  shared `MEMORY_DATABASE_URL` (never duplicated into a second secret).
- When `EMPLOYEE_ENABLED=false`, no storage is opened at all.

## 3. Expiry reaper (Phase 2)

`EmployeeReaper` runs an immediate sweep on start and then on an interval. Each
sweep:

1. deletes artifacts whose TTL has passed;
2. deletes task records past `expiresAt`;
3. removes the on-disk workspace directory for every evicted task.

Workspace deletion is **fail-closed**: a path that would escape the configured
workspace root (or a task id that does not match the `emp-` shape) is skipped
rather than followed. Sweeps are idempotent and best-effort; a failed removal
never extends a TTL or resurrects a record. The reaper timer is `unref`'d so it
never keeps the process alive.

## 4. Cancellation lifecycle (Phase 3)

- **Running task:** `POST /api/ai/employee/cancel` aborts the task's
  `AbortController`; the executor returns a `CANCELED` result which is persisted
  to durable storage. Cancellation is cooperative — the pipeline checks the
  signal between steps.
- **Queued task:** cancel removes it from the queue immediately and persists a
  terminal `CANCELED` record without ever starting it.
- Cancel of an unknown or already-terminal task returns a non-cancelling result
  (`canceled: false`); the route is a `404` no-op for unknown ids (idempotent).
- The inbound request `AbortSignal` is intentionally **not** wired to task
  cancellation after a `202`: a client disconnect must not silently kill work
  the Hub has already recorded. Cancellation is explicit.

## 5. Bounded concurrency and backpressure (Phase 4)

Admission control is enforced in `EmployeeService.execute` before a task is
accepted:

- `EMPLOYEE_MAX_ACTIVE_TASKS` — global cap on concurrently executing tasks.
- `EMPLOYEE_MAX_USER_ACTIVE_TASKS` — per-client cap on in-flight tasks.
- `EMPLOYEE_QUEUE_CAPACITY` — bounded backlog of accepted-but-not-yet-started
  tasks.

Tasks beyond the global (`active + queue capacity`) or per-client limit are
rejected with `AI_EMPLOYEE_RESOURCE_LIMIT` (HTTP `429`) rather than queued
without bound. Accepted tasks wait in a bounded queue and are started as slots
free. On restart, the queue is not resumed: queued tasks are marked `FAILED`,
which is the safe recovery behaviour (no orphan, no stuck task).

## 6. Configuration reference

| Variable                         | Default                             | Purpose                                       |
| -------------------------------- | ----------------------------------- | --------------------------------------------- |
| `EMPLOYEE_ENABLED`               | `true`                              | Master switch; disabled -> every route `403`. |
| `EMPLOYEE_WORKSPACE_ROOT`        | `.employee-workspaces`              | Base dir for task workspaces.                 |
| `EMPLOYEE_MAX_EXECUTION_MS`      | `600000`                            | Per-task deadline.                            |
| `EMPLOYEE_MAX_TOOL_CALLS`        | `100`                               | Per-task AG-004 tool-call budget.             |
| `EMPLOYEE_MAX_ARTIFACT_BYTES`    | `52428800`                          | Reviewed ZIP size cap.                        |
| `EMPLOYEE_MAX_REQUEST_TEXT`      | `8000`                              | Accepted request-text length.                 |
| `EMPLOYEE_STORAGE_BACKEND`       | prod: `durable`                     | Durable vs in-memory storage.                 |
| `EMPLOYEE_DATABASE_URL`          | falls back to `MEMORY_DATABASE_URL` | Durable storage DSN.                          |
| `EMPLOYEE_MAX_ACTIVE_TASKS`      | `4`                                 | Global concurrent execution cap.              |
| `EMPLOYEE_MAX_USER_ACTIVE_TASKS` | `1`                                 | Per-client in-flight cap.                     |
| `EMPLOYEE_QUEUE_CAPACITY`        | `16`                                | Bounded backlog size.                         |
| `EMPLOYEE_ARTIFACT_TTL_MS`       | `86400000`                          | Record/artifact lifetime.                     |
| `EMPLOYEE_REAP_INTERVAL_MS`      | `600000`                            | Reaper sweep interval.                        |

## 7. Tests

- `tests/unit/agents/employee-ai/storage.test.ts` — repository round-trip,
  write-through persistence, hydration (interrupted -> `FAILED`, terminal
  reload, durable artifact read), admission control (per-client, global,
  queueing/drain), reaper (record + artifact + workspace removal), and backend
  resolution (production rejects in-memory).
- `tests/integration/employee/postgres.integration.test.ts` — real PostgreSQL,
  gated by `AIOS_TEST_DATABASE_URL` (isolated DB only, never the production
  `MEMORY_DATABASE_URL`): migrations `300`/`301`, task/artifact round-trip,
  restart durability, non-terminal detection, and TTL reaping.

Schema migration versions: `300` (employee_tasks), `301` (employee_artifacts).

## 7b. Readiness

`/healthz` and `/health` include the employee probe (`probeEmployee`), which is
healthy only when the subsystem is enabled **and** the storage backend reports
healthy. In durable mode this issues a real `SELECT 1`, so a lost database
connection surfaces in readiness rather than silently failing later.

---

## 8. Deployment verification (Prompts20)

Prompts20 prepared and verified production deployment. Changes touching this
subsystem:

- **Health/readiness actually surfaced.** The `probeEmployee` described in �7b
  is now part of the HTTP `HealthPayload` (`src/app/runtime.ts`):
  `/readyz` and `/healthz` include
  `"employee": { "enabled": ..., "healthy": ..., "storage": "durable" | "in-memory" }`.
  An **enabled** employee with unhealthy storage flips the aggregate `status` to
  `degraded`; a disabled employee never does.
- **`render.yaml`** declares the employee production configuration explicitly:
  `EMPLOYEE_ENABLED=true`, `EMPLOYEE_STORAGE_BACKEND=durable`,
  `EMPLOYEE_DATABASE_URL` (`sync: false`, falls back to `MEMORY_DATABASE_URL`),
  `EMPLOYEE_WORKSPACE_ROOT=/app/.employee-workspaces`, plus explicit concurrency,
  queue, TTL and reaper values � retention and resource limits are no longer
  implicit defaults.
- **`.env.example`** documents every `EMPLOYEE_*` variable name (names only, no
  secrets) so a deployer can see the full surface.
- **`Dockerfile`**: the runtime directories, including the employee workspace
  root, are created and owned by the non-root `node` user, so employee tasks can
  `mkdir` their workspace inside the container.
- **`.dockerignore`** now also excludes `.env.*` (keeping `.env.example`) and
  `.employee-workspaces`, so neither a local env file nor generated workspaces
  can enter the build context.
- **`scripts/validate-env.ts`** validates the employee backend: production +
  explicit `in-memory` fails closed, and `durable` requires a connection string.

Verification performed (isolated local services only, synthetic credentials):

| Check                                                                                                            | Result |
| ---------------------------------------------------------------------------------------------------------------- | ------ |
| Production-mode container boots, `/healthz` + `/readyz` return `status:ok`, `employee.storage=durable`           | Passed |
| Employee migrations `300`/`301` applied automatically at container boot (tables present in the isolated test DB) | Passed |
| Non-root `node` (uid 1000) can create/write the workspace path in the image                                      | Passed |
| Business endpoint without `x-aios-service-token` ? 401 (fail closed)                                             | Passed |
| `SIGTERM` ? drain ? `Server closed gracefully`, exit code 0                                                      | Passed |
| `npm run validate:env` fails closed on `NODE_ENV=production` + `EMPLOYEE_STORAGE_BACKEND=in-memory`              | Passed |
| Full AIOS suite (2,466 tests) and explicit PostgreSQL integration suite (6 tests)                                | Passed |
