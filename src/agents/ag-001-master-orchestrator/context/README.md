# Context Builder Engine (AG-001 — Sprint 3)

Deterministic, token-budget-aware context assembly for the Master Orchestrator.

## Purpose

Turns a normalized request plus any supplied context inputs into a validated,
prioritized, budget-bounded `ContextSnapshot`. Designed to compose later with
AG-002 (Memory), AG-003 (Knowledge) and AG-004 (Tool) via provider interfaces
— without importing or calling any of them today.

## Responsibilities

- Validate and normalize supplied context items.
- Deduplicate equivalent items deterministically.
- Assign priority and order items/sections deterministically.
- Enforce total, per-section and reserved token budgets.
- Produce a `ContextSnapshot`, `ContextStatistics`, warnings and errors.

## Non-responsibilities

- **No** routing, execution planning, agent execution.
- **No** memory/knowledge/tool retrieval — nothing is fetched externally.
- **No** LLM/API calls, no business logic.
- **No** compression via summarization (interface only, deterministic fallback).

## Architecture

```text
context/
  types/        # ContextItem, ContextSnapshot, ContextBudget, statistics...
  interfaces/   # TokenEstimator, ContextCompressor, future providers (AG-002..004)
  config/       # env-driven configuration (Zod-validated)
  errors/       # ContextBuild/Validation/Budget/Overflow/Normalization errors
  validators/   # request/budget/item shape validation
  builders/     # normalizer, deduplicator, ContextBuilder orchestration
  prioritizers/ # deterministic priority + section ordering
  compressors/  # compression pipeline (deterministic, no AI)
  budget/       # BudgetManager: priority-tier allocation + trimming
  utils/        # ranks, section order, hashing
```

## Input

`ContextBuildRequest { requestId?, traceId?, items, budget? }`. Only the items
you pass in are used — nothing is fetched.

## Output

`ContextBuildResult { snapshot, warnings, errors, statistics }`. The snapshot
holds the assembled `sections`, included `items`, `estimatedTokens`, the
effective `budget`, and the statistics.

## Priority model

`CRITICAL > HIGH > NORMAL > LOW > OPTIONAL`. Ordering within a priority:
explicit `order` hint, then source rank, then stable insertion order. Never
random.

## Budget model

- `maxTokens` — total cap.
- `reservedTokens` — set aside; usable budget is `maxTokens - reservedTokens`.
- `minTokens` — minimum budget that must remain available.
- `warningThreshold` — utilization (0..1) above which a warning is emitted.
- `overflowBehavior` — `truncate` (trim LOW/OPTIONAL first) or `fail` (throw).

Token counting uses the replaceable `TokenEstimator` abstraction; the default
is a documented approximation (~4 chars/token).

## Deduplication

Items are equivalent when source type + source id + section + priority +
content identity match. First occurrence wins. No embeddings or similarity.

## Overflow behavior

- LOW items are trimmed before HIGH; OPTIONAL is removed first.
- CRITICAL items are never dropped.
- If CRITICAL context alone exceeds the budget the build signals
  `CRITICAL_OVERFLOW` (and throws when `overflowBehavior` is `fail`).

## Future Memory integration

`MemoryContextProvider` (AG-002) — interface only. Inject provider output as
context items in a later sprint; nothing is called now.

## Future Knowledge integration

`KnowledgeContextProvider` (AG-003) — interface only.

## Future Tool integration

`ToolContextProvider` (AG-004) — interface only.

## Future compression

`ContextCompressor` is the seam. Today: `DeterministicCompressor` (whitespace
compaction) or `NullCompressor`. A future AI/LLM compressor implements the same
interface behind the `CONTEXT_COMPRESSION_ENABLED` flag.

## Testing

Unit tests cover empty/single/multiple items, priority and section ordering,
deduplication, invalid inputs, token estimation, budgets (total/per-section/
reserved), warnings, trimming, critical preservation and overflow, determinism,
provider compatibility, compression, statistics, configuration and errors.

## Examples

```ts
import { ContextBuilder, ContextPriority, ContextSectionType, ContextSourceType } from './index.js';

const builder = new ContextBuilder();

const result = builder.build({
  requestId: 'req_1',
  items: [
    {
      id: '1',
      source: { type: ContextSourceType.REQUEST },
      section: ContextSectionType.REQUEST,
      content: 'Please help me update my project',
      priority: ContextPriority.HIGH,
    },
  ],
});

console.log(result.snapshot.estimatedTokens);
console.log(result.statistics.includedItems);
```

Run quality gates from the repo root: `npm run lint`, `npm run typecheck`,
`npm test`, `npm run build`.
