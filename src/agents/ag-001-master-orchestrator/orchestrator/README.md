# orchestrator

End-to-end orchestration integration layer for the **AG-001 Master Orchestrator**
(prompt `prompts/prompts19`; spec
`docs/master-orchestrator-specification-v1.md`).

## Purpose

`MasterOrchestratorService` is the single, transport-independent entry point
that coordinates the existing Sprint 1–8 engines: validation → intent
classification → context building → agent routing → execution planning →
execution → aggregation → final response. It is a **coordinator only** — it
never implements engine algorithms.

## Responsibilities

- Coordinate the end-to-end request lifecycle (§3 of the prompt).
- Inject all engines through dependency injection; never construct them
  internally (use `createMasterOrchestratorService` as the composition root).
- Preserve correlation identifiers and stage artifacts across every stage.
- Fail closed when routing escalates; respect terminal execution states.
- Propagate cancellation to the execution engine and emit correlated events.

It does **not** do intent algorithms, routing, planning, execution,
aggregation, memory, knowledge retrieval, tool execution or business logic.

## Folder structure

```text
orchestrator/
  interfaces/  DI contracts for the six injected engines
  types/       OrchestrationRequest, OrchestratorResponse, OrchestratorStage
  errors/      OrchestrationError + stage-aware wrapping helper
  config/      re-exports the existing OrchestratorConfig (no duplication)
  validators/  validateOrchestrationRequest / normalizeOrchestrationRequest
  builders/    orchestrator response assembler
  services/    MasterOrchestratorService + event emitter
  index.ts     public barrel
  README.md
```

## Usage

```ts
import { createMasterOrchestratorService } from './orchestrator/index.js';

const orchestrator = createMasterOrchestratorService();

const response = await orchestrator.execute({
  text: 'Create a new project',
  role: UserRole.Freelancer,
});

console.log(response.status); // SUCCESS | PARTIAL | FAILED | CANCELLED | TIMED_OUT
```

## Dependency injection

The service accepts six engines via `MasterOrchestratorServiceDependencies`:

| Dependency           | Contract                       | Default (factory)           |
| -------------------- | ------------------------------ | --------------------------- |
| `intentClassifier`   | `IntentClassifier`             | `RuleBasedIntentClassifier` |
| `contextBuilder`     | `ContextBuilderContract`       | `ContextBuilder`            |
| `routingEngine`      | `RoutingEngineContract`        | `RoutingEngine`             |
| `planBuilder`        | `ExecutionPlanBuilderContract` | `ExecutionPlanBuilder`      |
| `executionEngine`    | `CancellableExecutionEngine`   | `ExecutionEngine`           |
| `aggregationService` | `AggregationServiceContract`   | `SharedAggregationService`  |

Overriding any dependency lets callers substitute deterministic doubles in
tests or alternative runtimes without touching engine code.

## Lifecycle

`execute()` runs: validation → intent detection → context building → routing →
(routing escalation ⇒ fail-closed) → planning → plan validation → (cancellation
check) → execution → aggregation → response. Each transition emits a correlated
`OrchestratorEvent` and preserves the artifacts needed for audit.

## Quality gates

Run from the repository root: `npm test`, typecheck, `npm run lint`,
`npm run build`.
