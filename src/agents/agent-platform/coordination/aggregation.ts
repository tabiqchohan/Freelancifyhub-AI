/**
 * Sprint 20 — Multi-Agent Coordination & Collaboration. Deterministic result
 * aggregation (Sprint 20 §13).
 *
 * Five bounded strategies over validated task results:
 *   COLLECT     → outputs keyed by task id
 *   MERGE       → deep structural merge of plain-object outputs
 *   BEST_RESULT → the single highest-priority / earliest completed output
 *   CONSENSUS   → the majority output when exactly identical; else review
 *   REVIEW      → all outputs wrapped; mustReview = true
 *
 * All outputs are passed through untrusted (JSON-safe) values and never
 * executed or evaluated.
 */

import {
  AggregationStrategy,
  TaskStatus,
  type ConflictRecord,
  type CoordinationAggregate,
  type CoordinationPlan,
  type TaskResult,
} from './types.js';

export type { CoordinationAggregate };

/** Aggregates validated results into the plan's chosen strategy. */
export function aggregateResults(
  plan: CoordinationPlan,
  results: readonly TaskResult[],
  conflictResolution: {
    decision: 'continue' | 'review_required' | 'fail';
    selectedTaskId?: string;
  },
  conflicts: readonly ConflictRecord[] = [],
): CoordinationAggregate {
  const completed = results.filter((r) => r.status === TaskStatus.Completed);
  const successCount = completed.length;
  const skippedCount = results.filter((r) => r.status === TaskStatus.Skipped).length;
  const failedCount = results.filter(
    (r) =>
      r.status === TaskStatus.Failed ||
      r.status === TaskStatus.Cancelled ||
      r.status === TaskStatus.TimedOut,
  ).length;
  const totalCount = results.length;
  const selectedTaskId = conflictResolution.selectedTaskId;
  const mustReview = conflictResolution.decision === 'review_required';

  let output: unknown;
  switch (plan.aggregation) {
    case AggregationStrategy.Collect: {
      const collected: Record<string, unknown> = {};
      for (const result of completed) {
        collected[result.taskId] = result.output;
      }
      output = Object.freeze(collected);
      break;
    }
    case AggregationStrategy.Merge: {
      const merged: Record<string, unknown> = {};
      for (const result of completed) {
        deepMergeInto(merged, result.output);
      }
      output = Object.freeze(merged);
      break;
    }
    case AggregationStrategy.BestResult: {
      const chosen = completed
        .filter((r) => selectedTaskId === undefined || r.taskId === selectedTaskId)
        .sort(
          (a, b) =>
            priorityOf(plan, b.taskId) - priorityOf(plan, a.taskId) ||
            orderOf(plan, a) - orderOf(plan, b),
        )[0];
      output = chosen?.output;
      break;
    }
    case AggregationStrategy.Consensus: {
      const consensus = findConsensus(completed.map((r) => r.output));
      if (consensus === undefined && completed.length > 0) {
        return buildAggregate({
          strategy: plan.aggregation,
          successCount,
          failureCount: failedCount,
          skippedCount,
          totalCount,
          mustReview: true,
          selectedTaskId,
          conflicts,
          output: Object.freeze({ results: completed.map((r) => r.output) }),
        });
      }
      output = consensus;
      break;
    }
    case AggregationStrategy.Review:
    default: {
      output = Object.freeze({ results: completed.map((r) => r.output) });
      break;
    }
  }

  const isReviewStrategy = plan.aggregation === AggregationStrategy.Review || mustReview;

  return buildAggregate({
    strategy: plan.aggregation,
    successCount,
    failureCount: failedCount,
    skippedCount,
    totalCount,
    mustReview: isReviewStrategy,
    selectedTaskId,
    conflicts,
    output,
  });
}

/** Deep-equality used by conflict detection; JSON-safe values only. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (typeof a !== typeof b) {
    return false;
  }
  if (a === null || b === null || a === undefined || b === undefined) {
    return a === b;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return false;
    }
    return a.every((value, index) => deepEqual(value, b[index]));
  }
  if (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null) {
    const keysA = Object.keys(a as object).sort();
    const keysB = Object.keys(b as object).sort();
    if (keysA.length !== keysB.length) {
      return false;
    }
    return keysA.every((key) =>
      deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    );
  }
  return false;
}

function deepMergeInto(target: Record<string, unknown>, value: unknown): void {
  if (value === null || value === undefined) {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      deepMergeInto(target, item);
    }
    return;
  }
  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const existing = target[key];
      if (existing !== undefined && isRecord(existing) && isRecord(child)) {
        deepMergeInto(existing as Record<string, unknown>, child);
      } else {
        target[key] = clone(child);
      }
    }
    return;
  }
  void value;
}

function clone(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => clone(item));
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = clone(child);
    }
    return out;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function findConsensus(outputs: readonly unknown[]): unknown | undefined {
  if (outputs.length === 0) {
    return undefined;
  }
  const groups = new Map<string, unknown[]>();
  for (const output of outputs) {
    const key = safeKey(output);
    const list = groups.get(key) ?? [];
    list.push(output);
    groups.set(key, list);
  }
  let bestKey: string | undefined;
  let bestCount = 0;
  for (const [key, list] of groups) {
    if (list.length > bestCount) {
      bestCount = list.length;
      bestKey = key;
    }
  }
  if (bestKey === undefined || bestCount <= outputs.length / 2) {
    return undefined;
  }
  const group = groups.get(bestKey)!;
  return group[0];
}

/** Deterministic textual key of a JSON-safe output (for consensus grouping). */
function safeKey(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}

function buildAggregate(input: {
  readonly strategy: AggregationStrategy;
  readonly successCount: number;
  readonly failureCount: number;
  readonly skippedCount: number;
  readonly totalCount: number;
  readonly mustReview: boolean;
  readonly selectedTaskId?: string;
  readonly conflicts: readonly ConflictRecord[];
  readonly output?: unknown;
}): CoordinationAggregate {
  return Object.freeze({
    strategy: input.strategy,
    output: input.output,
    successCount: input.successCount,
    failureCount: input.failureCount,
    skippedCount: input.skippedCount,
    totalCount: input.totalCount,
    conflicts: input.conflicts,
    mustReview: input.mustReview,
    selectedTaskId: input.selectedTaskId,
  });
}

function priorityOf(plan: CoordinationPlan, taskId: string): number {
  return plan.tasks.find((t) => t.taskId === taskId)?.priority ?? 0;
}

function orderOf(plan: CoordinationPlan, result: TaskResult): number {
  return plan.tasks.findIndex((t) => t.taskId === result.taskId);
}
