# Production Deployment — Freelancify AI (AIOS)

Operational guide for deploying this service to **Render** as a Web Service.
Written during prompts15 Phase 17.

> **Scope note.** Everything below was verified against an isolated local
> container. It has **not** been verified against a live Render deployment or the
> production Neon database, because no production credentials or deployment
> access were available. Items marked **[UNVERIFIED IN PRODUCTION]** need
> confirmation by whoever performs the first deploy.

---

## 1. What this service is

A server-to-server AI orchestration service. It is **not** user-facing: browsers
never talk to it directly. The only supported caller is FreelancifyHub.

```
FreelancifyHub (Vercel)  --HTTPS + x-aios-service-token-->  AIOS (this service)
                                                                   |
                                                        Neon PostgreSQL + LLM provider
```

---

## 2. Build and run

| Setting           | Value                             | Why                                                |
| ----------------- | --------------------------------- | -------------------------------------------------- |
| Build command     | `npm ci && npm run build`         | `npm ci` for a lockfile-exact install, then `tsc`. |
| Start command     | `npm start`                       | Runs `node dist/index.js`.                         |
| Node              | 22.x (image) / `>=22` (`engines`) | Matches the Dockerfile.                            |
| Health check path | `/readyz`                         | Probes dependencies, returns 503 when degraded.    |
| Region            | Same as the Neon primary          | Avoids cross-region latency on every request.      |

`render.yaml` in the repository root encodes all of this. Secrets are declared
with `sync: false` so no secret value is ever committed.

### Docker

The `Dockerfile` is a four-stage build (`base` → `deps` → `build` → `runtime`).

Two things about it matter operationally:

1. **`NODE_ENV=production` is set only in the runtime stage.** Setting it on the
   shared base made `npm ci` omit devDependencies, which broke the build twice
   over: `prepare: husky` could not resolve its binary (`npm ci` exited 127) and
   `typescript` was absent so `npm run build` could not run. The image could not
   be built at all.
2. **`npm ci --ignore-scripts`** in the deps stage. The only lifecycle script is
   `prepare: husky`, a git-hook installer that is meaningless in a build context
   with no `.git` and fails the build when it runs.

The final image contains no dev tooling (`typescript`, `eslint`, `pino-pretty`,
`husky` are all absent) and does contain the runtime deps (`pino`, `pg`,
`dotenv`, `zod`).

### Health probe

```
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3
```

It uses `node -e` rather than `curl`/`wget` because the alpine runtime image has
neither, and installing one purely for health checks would widen the attack
surface. The port is read from `$PORT`, so overriding it (as Render does) keeps
the probe correct without a rebuild.

---

## 3. Health endpoints

| Path       | Auth | Meaning                                                           |
| ---------- | ---- | ----------------------------------------------------------------- |
| `/livez`   | none | Pure process signal. Never probes dependencies. Use for liveness. |
| `/readyz`  | none | Bounded dependency probe (2 s). 503 when degraded or timed out.   |
| `/healthz` | none | Alias of `/readyz`.                                               |
| `/health`  | none | Alias of `/readyz`.                                               |

Business endpoints (`/api/**`, `/runtime/request`) require
`x-aios-service-token`. Liveness and readiness stay open so the platform can
probe them without credentials — they expose no user data, no secrets and no
prompt content.

---

## 4. Environment variables

### Required — set as Render secrets (`sync: false`)

| Variable              | Notes                                                                     |
| --------------------- | ------------------------------------------------------------------------- |
| `AIOS_SERVICE_TOKEN`  | Shared token the Hub presents via `x-aios-service-token`.                 |
| `AIOS_ADMIN_TOKEN`    | Management operations via `x-aios-admin-token`.                           |
| `MEMORY_DATABASE_URL` | Neon Postgres connection string. Only needed when a backend is `durable`. |

### Required when enabling AI

| Variable       | Notes                                                                 |
| -------------- | --------------------------------------------------------------------- |
| `LLM_ENABLED`  | Master flag. Anything but `true` disables AI reasoning (fail-closed). |
| `LLM_PROVIDER` | `mock` (deterministic, no network) or `http` (OpenAI-compatible).     |
| `LLM_API_KEY`  | Secret. Required when `LLM_ENABLED=true` **and** `LLM_PROVIDER=http`. |
| `LLM_MODEL`    | Must be verified against the provider's current availability.         |

### LLM settings worth understanding before you enable AI

| Variable                 | Default                     | Notes                                                                                                                                                                                                                                                                                                                  |
| ------------------------ | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LLM_BASE_URL`           | `https://api.openai.com/v1` | Must be an absolute **https** URL. Plaintext `http` is accepted only for a loopback gateway (`localhost`/`127.0.0.1`/`::1`) so a local Ollama or vLLM can be used. Embedded credentials and query strings are rejected — a schemeless or `http://` value now fails at **startup** instead of failing on every request. |
| `LLM_TIMEOUT_MS`         | `30000`                     | Per **attempt**, not total. The retry chain is additionally bounded by the step/request deadline and the caller's socket, so back-off and later attempts can never outlive the request that started them (see §9).                                                                                                     |
| `LLM_MAX_RESPONSE_BYTES` | `1048576`                   | Ceiling on the buffered upstream body. `content-length` is treated as a hint only; the streaming reader enforces the real budget, so an oversized or lying `content-length` is still rejected.                                                                                                                         |
| `LLM_MAX_CONTEXT_BYTES`  | `65536`                     | Bounds the assembled user message.                                                                                                                                                                                                                                                                                     |

Other guarantees worth relying on: a blank `LLM_API_KEY` makes the HTTP provider
throw rather than send `Authorization:` with an empty value; 400/401/403/404/422
and validation failures are **not** retried; upstream `statusText` is stripped of
control characters before it reaches an error message; and base-URL userinfo is
scrubbed before the endpoint is logged.

### Non-secret

| Variable                     | Default       | Notes                                                            |
| ---------------------------- | ------------- | ---------------------------------------------------------------- |
| `NODE_ENV`                   | `development` | Must be `production` in the deployed service.                    |
| `HOST`                       | `0.0.0.0`     | Required so the platform can route to the container.             |
| `PORT`                       | `3000`        | Render injects this; do not pin it.                              |
| `LOG_LEVEL`                  | `info`        |                                                                  |
| `LOG_PRETTY`                 | `false`       | See below.                                                       |
| `AIOS_ALLOW_UNAUTHENTICATED` | `false`       | Dev escape hatch, **always ignored when `NODE_ENV=production`**. |

### Storage backends — read this carefully

`MEMORY_STORAGE_BACKEND`, `KNOWLEDGE_STORAGE_BACKEND` and
`TOOLS_STORAGE_BACKEND` accept **exactly two values**:

- `in-memory` — default, non-durable. Process-local data is lost on restart.
- `durable` — PostgreSQL. Requires `MEMORY_DATABASE_URL`.

Any other value fails closed at boot with `UNSUPPORTED_STORAGE_BACKEND`.
**`postgres` is NOT a valid value**, even though the storage engine is
PostgreSQL. This was previously documented incorrectly in `.env.example`, which
would have turned a correct-looking config into an immediate crash.

---

## 5. Logging in production

`LOG_PRETTY=true` attaches a `pino-pretty` transport. `pino-pretty` is a
**devDependency**, and the runtime image is pruned with `npm prune --omit=dev`,
so it is not installed in the container. Honouring the flag there makes pino
throw `unable to determine transport target for "pino-pretty"` while constructing
the logger — i.e. before the server ever binds its port.

`src/lib/logger.ts` therefore forces structured JSON whenever
`NODE_ENV=production`, and logs a one-line notice if pretty logging was
requested. This is deliberately fail-safe rather than fail-closed: pretty logs are
a developer convenience, so degrading to JSON is better than refusing to start.

Set `LOG_PRETTY=false` in production anyway, so the intent is explicit.

---

## 6. Shutdown and deploys

Render sends `SIGTERM` before replacing an instance.

- `src/index.ts` handles `SIGTERM` and `SIGINT`, and is idempotent.
- `ProductionRuntime.shutdown()` calls `server.closeIdleConnections()`, then waits
  up to `SHUTDOWN_DRAIN_TIMEOUT_MS` (10 s) for in-flight work, then calls
  `server.closeAllConnections()` so a stuck socket cannot hold the drain open.
- `src/index.ts` also arms a `SHUTDOWN_DRAIN_TIMEOUT_MS + 5 s` force-exit
  watchdog, so the process always terminates well inside the platform's grace
  period rather than being `SIGKILL`ed and reported as an unclean shutdown.

---

## 7. Pre-deploy checks

Run these in the repo. All are offline and touch no production database.

```bash
npm ci
npm run typecheck
npm run lint
npm test
npm run build
npm run validate:env            # parses the real environment
npm run validate:env-example    # detects .env.example <-> schema drift
```

`validate:env-example` is a drift detector: it parses `.env.example` through the
same compiled parser the composition root uses at boot and asserts every
documented backend value is one the root accepts. Add it to CI so the two cannot
diverge again.

---

## 8. Test database hygiene

Integration suites must never touch a production database.

- `src/lib/test-database-guard.ts` resolves **only** `AIOS_TEST_DATABASE_URL`. It
  never falls back to `MEMORY_DATABASE_URL` — that fallback is what previously
  wrote test rows into the live database.
- The guard fails closed: the URL must be loopback, must not look like a managed
  Postgres provider, and the database name must not look production-like. The URL
  is never included in error messages.
- When `AIOS_TEST_DATABASE_URL` is unset the suites **skip**. They do not connect.

Set a separate, disposable database locally:

```bash
AIOS_TEST_DATABASE_URL=postgresql://localhost:5432/aios_test npm test
```

---

## 9. Cancellation, deadlines and retry semantics

When a request lands on `/api/ai/*`, the runtime owns the request's lifetime end
to end. A client that hangs up, a slow LLM that overruns, and a bounded retry
chain all terminate the same work instead of leaving it billing in the
background.

```
Request (HTTP)
    ↓
AbortSignal + Execution Deadline
    ↓
ExecutionEngine
    ↓
AgentExecutor
    ↓
AIReasoningService
    ↓
generateWithRetry
    ↓
bounded fetch()
    ↓
LLM Provider
```

- **The caller owns the execution deadline.** Once the AIOS request timeout
  (`aios.taskTimeoutMs`, default `AIOS_REQUEST_TIMEOUT_MS`) is spent, the
  execution context records `deadlineAt` and the tail stops starting new work.
- **The LLM layer respects the remaining time.** Each executor step derives its
  own deadline as `min(step policy timeout, executor default timeout)`, and the
  reasoning/agentic service passes it to `generateWithRetry`. `generateWithRetry`
  refuses to start an attempt whose window has closed, clamps each attempt's
  provider timeout to the budget that actually remains, and refuses a backoff
  that no longer fits before sleeping. Retries **cannot outlive the caller
  budget**.
- **Client disconnect cancels work.** The runtime attaches an `AbortSignal` to
  every request that fires when the client socket tears down mid-request
  (aborted request stream, or a response that closes early). The disconnect is
  logged as `http request aborted` (reason `request_aborted`). That signal is
  composed with the explicit `/cancel` controller, so either event aborts the
  run.
- **Deadline cancels work too.** Reaching a deadline and receiving a cancel are
  the same mechanism; the engine answers both with a cancelled run, and the
  agent executor stops rather than continuing to the LLM.
- **Provider requests are actually terminated.** The HTTP LLM provider composes
  its per-attempt timeout controller with the caller's signal and passes it to
  `fetch()`. A timeout or a disconnect tears down the real outbound socket
  (verified against a stalling upstream), instead of abandoning the fetch and
  leaving it open.

Observed shapes worth knowing:

- `http request aborted` with `reason: 'request_aborted'` appears in the request
  log when a client disconnects.
- A cancelled execution finishes with `status: 'CANCELLED'` (not a hang); a step
  that was aborted mid-reasoning reports the cancellation rather than retrying.
- `LLM_TIMEOUT_MS` remains a per-attempt ceiling. The total LLM time for a
  request is bounded by the first of: the step deadline, the request deadline,
  or an actual client socket teardown — the caller can always pull the plug from
  outside.

---

## 10. Known gaps

- **[UNVERIFIED IN PRODUCTION]** No live Render deployment has been performed.
- **[UNVERIFIED IN PRODUCTION]** No connection to the production Neon database;
  no migration has been applied or verified there.
- **[UNVERIFIED IN PRODUCTION]** `LLM_PROVIDER=http` has not been exercised
  against a real provider. `LLM_ENABLED=false` is the safe default.
- Neon credential rotation still requires manual confirmation; the repository
  contains no evidence that it happened.
- `docs/final-launch-readiness.md` is referenced by the test-database guard but
  does not exist in this repository. Either create it or drop the reference.
