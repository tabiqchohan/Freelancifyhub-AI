# Getting Started

## Prerequisites

- Node.js **22+** (`.nvmrc` pins 24)
- npm (Corepack-managed via `packageManager` in `package.json`)
- Docker + Docker Compose (optional, for containers)
- OpenClaw CLI (optional, for the AI gateway integration)

## Install

```sh
npm install
```

## Environment

```sh
cp .env.example .env
npm run validate:env
```

## Development

```sh
npm run dev          # tsx watch — hot reload
npm test             # Vitest (one-shot)
npm run test:watch   # Vitest (watch)
npm run lint         # ESLint
npm run typecheck    # tsc --noEmit
npm run build        # tsc → dist/
npm start            # run compiled output
```

## Docker

```sh
docker compose build
docker compose up -d
curl http://localhost:3000/healthz
```

## OpenClaw

```sh
OPENCLAW_CONFIG_PATH=./clawd.json openclaw gateway start
openclaw config validate
```

See `docs/ai-ecosystem.md` for the agent/memory/knowledge layout.
