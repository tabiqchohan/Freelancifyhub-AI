# AI Ecosystem

Freelancify AI is the orchestration layer of FreelancifyHub. It contains no
business logic yet — it is a production-ready foundation for the agent
ecosystem that will power the marketplace.

## Layers

```
┌──────────────────────────────────────────────────────────────┐
│  Gateway / Orchestration                                     │
│  OpenClaw (clawd.json) routes to agents/                     │
├──────────────────────────────────────────────────────────────┤
│  Agents            agents/        identity + role + rules    │
│  Prompts           prompts/       versioned prompt templates │
│  Workflows         workflows/     multi-step task definitions│
├──────────────────────────────────────────────────────────────┤
│  Knowledge         knowledge/     RAG ground-truth documents │
│  Memory            memory/        persistent agent state     │
│  Tools             tools/         sandboxed capability list  │
├──────────────────────────────────────────────────────────────┤
│  Runtime (Node.js 22, TypeScript, ESM)                       │
│  src/config  Zod-validated environment                       │
│  src/lib     pino logging, health server                     │
├──────────────────────────────────────────────────────────────┤
│  Ops                                                            │
│  logs/        runtime logs      scripts/   utility scripts   │
│  config/      file config       tests/     Vitest suites     │
│  docs/        documentation     CI: GitHub Actions + Docker  │
└──────────────────────────────────────────────────────────────┘
```

## OpenClaw integration

- `clawd.json` exposes the repository as an OpenClaw gateway config.
- Each directory under `agents/` is an OpenClaw agent directory (`agent.md`
  identity file, plus optional `SOUL.md` / `AGENTS.md`).
- `memory/` and `knowledge/` map to OpenClaw's persistent memory and knowledge
  stores, and are mounted as volumes in Docker.
- Runtime logs are written to `logs/` (pino).

## Adding an agent

1. `mkdir agents/<id>` and write `agents/<id>/agent.md`.
2. Register the agent in `clawd.json` → `agents.list`.
3. Reference prompts in `prompts/` and documents in `knowledge/`.
4. `openclaw config validate` and restart the gateway.

## Conventions

- Everything is versioned, reviewed and schema-validated where possible.
- Secrets never live in the repository; they come from the environment.
- No business logic lives in the foundation — add it behind the
  `src/` modules or agent/workflow definitions.
