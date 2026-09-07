/**
 * Sprint 20 — Multi-Agent Coordination & Collaboration. Deterministic conflict
 * detection and resolution (Sprint 20 §14).
 *
 * Conflicts are detected from validated results and statuses alone — no LLM,
 * no semantic inference. Resolution follows the plan's {@link ConflictPolicy}
 * and is applied by the aggregator; the {@link CoordinationConflictError} is
 * thrown when the policy forbids the conflict (FAIL_ON_CONFLICT).
 */

import { CoordinationConflictError } from './errors.js';
import {
  ConflictPolicy,
  CoordinationMode,
  TaskFailurePolicy,
  TaskStatus,
  type ConflictRecord,
  type ConflictResolution,
  type CoordinationPlan,
  type TaskResult,
} from './types.js';
import { deepEqual } from './aggregation.js';

/** Reads only what the detector needs from the plan/result set. */
export interface ConflictDetectionInput {
  readonly plan: CoordinationPlan;
  readonly results: readonly TaskResult[];
  readonly statusByTaskId: Readonly<Record<string, TaskStatus>>;
}

/** Detects conflicts deterministically from validated results + statuses. */
export function detectConflicts(input: ConflictDetectionInput): readonly ConflictRecord[] {
  const { plan, results } = input;
  const conflicts: ConflictRecord[] = [];
  const completed = results.filter((r) => r.status === TaskStatus.Completed);
  const tail = (record: ConflictRecord): ConflictRecord => record;

  // 1. Duplicate results: same objective + same agent ran twice successfully.
  if (completed.length >= 2) {
    const byKey = new Map<string, TaskResult[]>();
    for (const result of completed) {
      const objective = plan.tasks.find((t) => t.taskId === result.taskId)?.objective ?? '';
      const key = `${result.agentId}|${objective}`;
      const list = byKey.get(key) ?? [];
      list.push(result);
      byKey.set(key, list);
    }
    for (const [key, list] of byKey) {
      if (list.length >= 2) {
        conflicts.push(
          tail({
            type: 'duplicate_results',
            taskIds: list.map((r) => r.taskId),
            detail: `agent ${list[0]?.agentId} produced duplicate results for "${key}"`,
          }),
        );
      }
    }
  }

  // 2. Contradictory outputs: same objective, same agent, different outputs.
  if (completed.length >= 2) {
    const byKey = new Map<string, TaskResult[]>();
    for (const result of completed) {
      const objective = plan.tasks.find((t) => t.taskId === result.taskId)?.objective ?? '';
      const key = `${result.agentId}|${objective}`;
      const list = byKey.get(key) ?? [];
      list.push(result);
      byKey.set(key, list);
    }
    for (const [key, list] of byKey) {
      if (list.length < 2) {
        continue;
      }
      const first = list[0]!.output;
      const differs = list.slice(1).some((other) => !deepEqual(first, other.output));
      if (differs) {
        conflicts.push(
          tail({
            type: 'contradictory_outputs',
            taskIds: list.map((r) => r.taskId),
            detail: `agent ${list[0]?.agentId} produced contradictory outputs for "${key}"`,
          }),
        );
      }
    }
  }

  // 3. Incompatible statuses: REQUIRE_ALL coordination with a failed/timed-out task.
  if (plan.failurePolicy === TaskFailurePolicy.RequireAll) {
    const unhappy = results.filter(
      (r) =>
        r.status === TaskStatus.Failed ||
        r.status === TaskStatus.TimedOut ||
        r.status === TaskStatus.Cancelled ||
        r.status === TaskStatus.Skipped,
    );
    if (unhappy.length > 0) {
      conflicts.push(
        tail({
          type: 'incompatible_statuses',
          taskIds: unhappy.map((r) => r.taskId),
          detail: `REQUIRE_ALL coordination has non-completed tasks: ${unhappy.map((r) => r.status).join(', ')}`,
        }),
      );
    }
  }

  // 4. Agent disagreement: DEBATE coordination ended with differing outputs.
  if (plan.mode === CoordinationMode.Debate && completed.length >= 2) {
    const outputs = completed.map((r) => r.output);
    const first = outputs[0];
    if (outputs.slice(1).some((output) => !deepEqual(first, output))) {
      conflicts.push(
        tail({
          type: 'agent_disagreement',
          taskIds: completed.map((r) => r.taskId),
          detail: 'DEBATE participants produced disagreeing outputs',
        }),
      );
    }
  }

  // 5. Missing dependency output: completed task whose required dep never produced a result.
  const taskIds = new Set(plan.tasks.map((t) => t.taskId));
  for (const result of results) {
    if (result.status !== TaskStatus.Completed) {
      continue;
    }
    for (const dep of plan.tasks.find((t) => t.taskId === result.taskId)?.dependencies ?? []) {
      if (!taskIds.has(dep)) {
        continue;
      }
      const depResult = results.find((r) => r.taskId === dep);
      if (depResult === undefined) {
        conflicts.push(
          tail({
            type: 'missing_dependency_output',
            taskIds: [result.taskId, dep],
            detail: `task ${result.taskId} completed but dependency ${dep} produced no result`,
          }),
        );
      }
    }
  }

  return Object.freeze(conflicts);
}

/** Resolves detected conflicts per the plan's policy (Sprint 20 §14). */
export function resolveConflicts(
  plan: CoordinationPlan,
  conflicts: readonly ConflictRecord[],
  results: readonly TaskResult[],
): ConflictResolution {
  if (conflicts.length === 0) {
    return {
      conflicts,
      decision: 'continue',
      message: 'no conflicts detected',
    };
  }
  switch (plan.conflictPolicy) {
    case ConflictPolicy.Priority: {
      const sorted = [...results]
        .filter((r) => r.status === TaskStatus.Completed)
        .sort((a, b) => priorityOf(plan, b.taskId) - priorityOf(plan, a.taskId));
      const selected = sorted[0];
      return {
        conflicts,
        decision: 'continue',
        selectedTaskId: selected?.taskId,
        message: `priority policy selected task ${selected?.taskId ?? 'none'}`,
      };
    }
    case ConflictPolicy.FirstSuccess: {
      const order = plan.tasks.map((t) => t.taskId);
      const selected = results
        .filter((r) => r.status === TaskStatus.Completed)
        .sort((a, b) => order.indexOf(a.taskId) - order.indexOf(b.taskId))[0];
      return {
        conflicts,
        decision: 'continue',
        selectedTaskId: selected?.taskId,
        message: `first-success policy selected task ${selected?.taskId ?? 'none'}`,
      };
    }
    case ConflictPolicy.AllResults: {
      return {
        conflicts,
        decision: 'continue',
        message: 'all results retained for aggregation',
      };
    }
    case ConflictPolicy.ReviewRequired: {
      return {
        conflicts,
        decision: 'review_required',
        message: 'conflicts detected; aggregation must be reviewed',
      };
    }
    case ConflictPolicy.FailOnConflict:
    default: {
      return {
        conflicts,
        decision: 'fail',
        message: 'conflicts are not permitted under FAIL_ON_CONFLICT',
      };
    }
  }
}

/** Elevates a fail decision into the typed coordination error. */
export function throwIfConflictsFail(resolution: ConflictResolution): void {
  if (resolution.decision === 'fail') {
    throw new CoordinationConflictError(resolution.message, { conflicts: resolution.conflicts });
  }
}

function priorityOf(plan: CoordinationPlan, taskId: string): number {
  return plan.tasks.find((t) => t.taskId === taskId)?.priority ?? 0;
}

export type { ConflictResolution } from './types.js';
