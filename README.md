# Freelancify AI

> The AI ecosystem for **FreelancifyHub** — an AI-powered freelance marketplace.

This repository is a **production-ready foundation** for the Freelancify AI
ecosystem. It intentionally contains **no business logic**; it provides the
runtime, tooling, CI/CD, containerization and directory conventions that the
agent ecosystem will be built on.

## Stack

TypeScript 5 (strict, ESM) · Node.js 22+ · pino · Zod · ESLint 10 (flat) ·
Prettier · Husky + lint-staged · Vitest · Docker · GitHub Actions · OpenClaw.

## Quick start

```sh
npm install
cp .env.example .env
npm run validate:env
npm run dev            # http://localhost:3000/healthz
```

## Scripts

| Script                  | Description                             |
| ----------------------- | --------------------------------------- |
| `npm run dev`           | Run with hot reload (`tsx watch`)       |
| `npm run build`         | Type-check and compile to `dist/`       |
| `npm start`             | Run compiled output                     |
| `npm run lint`          | ESLint                                  |
| `npm run format`        | Prettier write                          |
| `npm test`              | Vitest (one-shot)                       |
| `npm run test:coverage` | Vitest with v8 coverage                 |
| `npm run typecheck`     | `tsc --noEmit`                          |
| `npm run validate:env`  | Validate environment against the schema |

## Architecture

```
├── src/                  # Runtime foundation (no business logic)
│   ├── config/           # Zod-validated environment (fail-fast)
│   └── lib/              # pino logging, health server
├── agents/               # OpenClaw agent identities
├── prompts/              # Versioned prompt templates
├── workflows/            # Declarative agent workflows
├── knowledge/            # Ground-truth / RAG documents
├── memory/               # Persistent agent state
├── tools/                # Sandboxed capability catalogue
├── logs/                 # Runtime logs
├── scripts/              # Utility scripts (tsx)
├── config/               # File-based configuration
├── tests/                # Vitest suites (unit / integration / e2e)
├── docs/                 # Architecture & guides
├── clawd.json            # OpenClaw gateway integration
├── Dockerfile            # Multi-stage, non-root production image
└── docker-compose.yml    # Local orchestration with health check
```

See
[`docs/product-requirements-v1.md`](docs/product-requirements-v1.md) for the
**official PRD (functional spec)**,
[`docs/agent-catalog-v1.md`](docs/agent-catalog-v1.md) for the **official Agent
Catalog & Registry (31 agents)**,
[`docs/master-orchestrator-specification-v1.md`](docs/master-orchestrator-specification-v1.md)
for the **AG-001 Master Orchestrator engineering spec**,
[`docs/shared-memory-architecture-v1.md`](docs/shared-memory-architecture-v1.md)
for the **AG-002 Shared Memory architecture spec**,
[`docs/tool-registry-architecture-v1.md`](docs/tool-registry-architecture-v1.md)
for the **AG-004 Tool Manager & Tool Registry architecture spec**,
[`docs/knowledge-base-architecture-v1.md`](docs/knowledge-base-architecture-v1.md)
for the **AG-003 Knowledge Manager architecture spec**,
[`docs/agent-development-kit-v1.md`](docs/agent-development-kit-v1.md)
for the **Agent Development Kit (ADK) standard**,
[`docs/freelancify-ai-blueprint-v1.0.md`](docs/freelancify-ai-blueprint-v1.0.md)
for the **official architecture guide**, [`docs/architecture.md`](docs/architecture.md)
for a deep dive, [`docs/ai-ecosystem.md`](docs/ai-ecosystem.md) for the AI layer,
and [`docs/getting-started.md`](docs/getting-started.md) for setup.

## License

Proprietary — FreelancifyHub. All rights reserved.
