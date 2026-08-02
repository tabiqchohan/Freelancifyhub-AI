# Architecture

Freelancify AI is the **AI ecosystem** for FreelancifyHub, an AI-powered
freelance marketplace. This repository is a clean, production-ready foundation
— no business logic is implemented. It provides the runtime, tooling and
directory conventions on top of which the AI ecosystem will be built.

## Technology stack

| Concern         | Choice                                    |
| --------------- | ----------------------------------------- |
| Language        | TypeScript 5 (strict, ESM)                |
| Runtime         | Node.js 22+ (`engines` + `.nvmrc`)        |
| Package manager | npm (Corepack-pinned)                     |
| Config          | Zod-validated environment (`src/config`)  |
| Logging         | pino (+ pino-pretty in dev)               |
| Linting         | ESLint 10 flat config + typescript-eslint |
| Formatting      | Prettier                                  |
| Git hooks       | Husky + lint-staged                       |
| Tests           | Vitest (+ v8 coverage)                    |
| Containers      | Multi-stage Dockerfile + Compose          |
| CI              | GitHub Actions (lint/type/test/build)     |
| AI gateway      | OpenClaw integration (`clawd.json`)       |

## Module layout (`src/`)

- `src/config/env.ts` — `dotenv` + Zod schema, `parseEnv()`.
- `src/config/index.ts` — eagerly parsed `env` singleton (fail-fast).
- `src/lib/logger.ts` — pino logger configured from the environment.
- `src/lib/server.ts` — minimal HTTP server exposing `/healthz`.
- `src/index.ts` — entry point: boot, health server, graceful shutdown.

## Environment

All configuration flows through `src/config/env.ts`. Every value is validated
at boot with Zod and fails fast with a readable error. New variables must be
added to the schema and documented in `.env.example`.

```ts
const EnvSchema = z.object({ NODE_ENV: ..., HOST: ..., PORT: ..., LOG_LEVEL: ... });
```

## Logging

pino is used for structured JSON logging. `LOG_PRETTY=true` (default in
development) enables human-readable output; production uses JSON lines that
any log collector can ingest.

## Errors & fail-fast

- Invalid environment → process exits at import with a list of issues.
- Unhandled shutdown signals (`SIGTERM`, `SIGINT`) → graceful close.

## AI ecosystem directories

| Directory    | Purpose                                |
| ------------ | -------------------------------------- |
| `agents/`    | OpenClaw agent identity files          |
| `prompts/`   | Versioned prompt templates             |
| `workflows/` | Declarative multi-step agent workflows |
| `knowledge/` | Ground-truth / RAG documents           |
| `memory/`    | Persistent agent state                 |
| `tools/`     | Sandboxed agent capability catalogue   |

These are consumed by the OpenClaw gateway (see `clawd.json` and
`docs/ai-ecosystem.md`).

## Deployment

The multi-stage `Dockerfile` produces a minimal, non-root runtime image. The
service exposes `GET /healthz` for orchestration health checks. Compose
mounts persistent volumes for `logs/`, `memory/` and `knowledge/`.
