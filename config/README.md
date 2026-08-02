# Config

Runtime configuration for the FreelancifyHub AI ecosystem.

Application configuration lives in code (`src/config/`) and is validated at
boot with Zod against the environment. This directory is reserved for
non-secret, file-based configuration that may grow over time (feature flags,
agent routing tables, etc.).

| File / source         | Purpose                                       |
| --------------------- | --------------------------------------------- |
| `.env.example`        | Documented environment variables template     |
| `src/config/env.ts`   | Zod schema + `parseEnv()` for the environment |
| `src/config/index.ts` | Eagerly parsed `env` singleton                |
| `clawd.json`          | OpenClaw gateway configuration (root)         |
