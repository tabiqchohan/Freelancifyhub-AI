# ag-001-master-orchestrator

Foundation for the **AG-001 Master Orchestrator** (catalog §9; blueprint §9; see
`docs/master-orchestrator-specification-v1.md`).

## Purpose

This module owns the typed foundations the orchestrator is built on: request
and execution context, typed `AgentRequest`/`AgentResponse` shapes, a validated
runtime configuration, the typed error hierarchy, and the pipeline / dependency
interfaces used by later sprints.

## Responsibilities

- Define strongly typed interfaces and shared types for the orchestrator.
- Provide builders for `RequestContext`, `ExecutionContext` and `AgentResponse`.
- Provide schema-driven validators (request, response, configuration).
- Provide typed, environment-validated configuration with safe defaults.
- Provide the orchestrator error hierarchy and dependency-injection contracts.

It does **not** do intent classification, routing, LLM calls, memory access,
knowledge retrieval, or tool invocation — those arrive in future sprints.

## Current Sprint

**Sprint 1 — Foundation** (implemented). See
`docs/master-orchestrator-specification-v1.md`.

| Sub-module    | Contains                                                                                                                                                                                            |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `interfaces/` | `RequestContext`, `AgentRequest`, `AgentResponse`, `AgentMetadata`, `ExecutionContext`, `ExecutionPlan`, `ExecutionResult`, `Pipeline*`, `AgentCapability`, `AgentDependency`, `AgentConfiguration` |
| `types/`      | scalar types, enums (`AgentCategory`, `AgentStatus`, `ExecutionStatus`, `DependencyType`), `ErrorInfo`, `AgentLimits`                                                                               |
| `errors/`     | `OrchestratorError` + `ValidationError`, `ConfigurationError`, `PipelineError`, `DependencyError`, `TimeoutError`                                                                                   |
| `config/`     | typed config, environment validation, defaults (no secrets hardcoded)                                                                                                                               |
| `schemas/`    | Zod schemas for request, response, metadata, config                                                                                                                                                 |
| `validators/` | `validateAgentRequest`, `validateAgentResponse`, `validateOrchestratorConfig`                                                                                                                       |
| `services/`   | DI container interfaces; pipeline abstractions (interface only)                                                                                                                                     |
| `builders/`   | `RequestContextBuilder`, `ExecutionContextBuilder`, `ResponseBuilder`                                                                                                                               |
| `utils/`      | scoped pino logger, id + timestamp helpers, generic schema validator                                                                                                                                |
| `tests/`      | README — runnable unit tests live under the repo `tests/` (Vitest)                                                                                                                                  |

## Future Sprints

- Intent detection and routing (Sprint 2)
- Memory, Knowledge and Tool client integration (Sprints 3–4)
- LLM execution and business logic (Sprint 5+)

## Folder Structure

```text
src/agents/ag-001-master-orchestrator/
  index.ts       # public barrel
  interfaces/    # typed contracts
  types/         # shared types + enums
  errors/        # error hierarchy
  config/        # typed runtime config
  schemas/       # Zod schemas
  validators/    # schema-driven validators
  services/      # DI + pipeline interfaces
  builders/      # context/response builders
  utils/         # logger, time, schema helpers
  tests/         # test notes (suite runs via repo tests/)
  README.md
```

## Quality Gates

Run from the repository root:

```sh
npm run lint
npm run typecheck
npm test
npm run build
```
