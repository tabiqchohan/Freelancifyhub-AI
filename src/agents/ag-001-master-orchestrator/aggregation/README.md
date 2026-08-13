# Response Aggregation & Result Processing (Sprint 7)

Part of the AG-001 Master Orchestrator. Transforms one or more execution
results into a single normalized, validated, deterministic orchestration
result — without any LLM, memory, knowledge, tool, external API or database
involvement.

## Purpose

Aggregate `ExecutionResult`s produced by the Sprint 6 execution engine into a
single `AggregatedResponse` that a downstream consumer (e.g. a future response
generation layer) can rely on.

## Responsibilities

- Validate execution results before processing.
- Normalize result structures into a common internal representation.
- Order results deterministically (plan order, step order, timestamps, stable
  step-id tie-breaker). Never random.
- Group results into `SUCCESSFUL`, `FAILED`, `PARTIAL`, `CANCELLED`,
  `TIMED_OUT`, `SKIPPED`, `PENDING`.
- Resolve step dependencies and represent dependency failures explicitly.
- Aggregate structured outputs preserving origin (agent, step, execution).
- Preserve errors and generate warnings.
- Detect duplicate results without discarding legitimate retries.
- Calculate a deterministic, explainable final status.
- Produce safe metadata/statistics.

## Non-responsibilities

- No Memory / Knowledge / Tool / Payment / Notification integration.
- No LLM calls, AI summarization, or natural-language response generation.
- No external APIs, database persistence, or social integrations.
- No agent or workflow execution.
- No business-specific response generation.

## Architecture

```
aggregation/
  types/         AggregationInput, NormalizedResult, AggregatedResponse, ...
  interfaces/    ResultNormalizer, ResultOrderer, ResultGrouper, StatusCalculator,
                 ResponseFormatter, Aggregator
  validators/    validateAggregationInput, validateExecutionResult
  normalizers/   ExecutionResultNormalizer
  status/        DeterministicStatusCalculator, executionStateToAggregationStatus
  statistics/    AggregationStatisticsCalculator
  formatters/    StructuredResponseFormatter
  aggregators/   SharedAggregationService + per-mode strategies
  config/        AggregationConfigSchema, parseAggregationConfig
  errors/        AggregationError hierarchy
  utils/         DeterministicResultOrderer, DefaultResultGrouper, sanitizeRecord
  index.ts
```

Pipeline: `validate → normalize → order → dedupe → group → status →
statistics → retries → format`.

## Input

```ts
interface AggregationInput {
  executionId: string;
  plan: ExecutionPlan;
  results: readonly ExecutionResult[];
  intent?: IntentResult;
  route?: RouteDecision;
  context?: ContextSnapshot;
}
```

## Output

```ts
interface AggregatedResponse {
  responseId: string;
  executionId: string;
  planId: string;
  requestId?: RequestId;
  traceId?: TraceId;
  status: AggregationStatus;
  outputs: readonly AggregatedOutput[];
  errors: readonly ResultError[];
  warnings: readonly ResultWarning[];
  statistics: AggregationStatistics;
  metadata: ResultMetadata;
  retries: readonly RetrySummary[];
  completedAt: IsoTimestamp;
}
```

## Normalization

Each `ExecutionStepResult` is copied into a `NormalizedResult` without mutating
the source. Errors are converted to safe `ResultError` objects; retry history
is reconstructed from step `attemptCount` and `STEP_RETRYING` events.

## Ordering

Deterministic: plan step position → step order → started-at timestamp →
step id. No randomness; identical input yields identical ordering.

## Grouping

Bucket by normalized status (`skipped: true` maps to `SKIPPED`, independent of
the underlying `Cancelled` status).

## Retry handling

A `RetrySummary` records the successful attempt (if any), failed attempts,
final attempt and retry count. Attempt history is never hidden.

## Dependency handling

Dependency edges come from `ExecutionPlan.dependencies`. When a dependent step
fails because its prerequisite failed, a `DEPENDENCY_FAILED` warning makes the
relationship explicit.

## Status calculation

`DeterministicStatusCalculator` derives the final status from execution states
(`CANCELLED` dominates, then `TIMED_OUT`, `FAILED`, `PARTIAL`, `COMPLETED`),
falling back to step-level evidence.

## Error handling

Errors preserve code, message, step id, agent id, execution id, retryable and
attempt. Errors are never silently discarded.

## Warning handling

Warnings cover partial execution, retries, fallback usage, skipped steps,
timeouts, non-critical failures, duplicate results and truncated metadata.
Warnings are deterministic and deduplicated.

## Statistics

Counts for executions, steps, successful/failed/partial/cancelled/timed-out/
skipped steps, retries, attempts, durations, agents, warnings, errors,
parallel branches and duplicates.

## Security

`sanitizeRecord` strips keys matching password/token/secret patterns. Metadata
only carries safe identifiers and counts; raw sensitive context is never
copied.

## Future response generation

Sprint 7 intentionally stops at structured, machine-readable output. A future
sprint may consume `AggregatedResponse` to generate user-facing copy.

## Testing

Covered: single/multi result, sequential/parallel/conditional/hybrid,
failed/partial/cancelled/timed-out/skipped, empty results, duplicates, retry
history, dependency ordering/failure, final status, failure policies, error and
warning aggregation, statistics, metadata, validation, result limits,
deterministic ordering/aggregation, and sensitive-data protection. A
determinism test asserts identical input yields an equivalent response.

## Examples

```ts
import { SharedAggregationService } from './aggregators/index.js';

const service = new SharedAggregationService();
const response = service.aggregate({ executionId: 'exec-1', plan, results });
```
