import type { ExecutionPlan } from '../../planning/types/index.js';
import { ExecutionStatus } from '../../types/index.js';
import { ExecutionState } from '../../execution/types/index.js';
import type {
  AggregationInput,
  AggregatedOutput,
  AggregatedResponse,
  AggregationStatistics,
  AggregationStatus,
  NormalizedResult,
  ResultError,
  ResultGroup,
  ResultMetadata,
  ResultWarning,
  RetrySummary,
} from '../types/index.js';
import type { ResponseFormatter } from '../interfaces/index.js';
import type { AggregationConfig } from '../config/index.js';

/**
 * Structured, machine-readable response formatter (prompt §14/§39). No LLM,
 * no natural-language generation: output stays structured and deterministic.
 */
export class StructuredResponseFormatter implements ResponseFormatter {
  readonly version = '1.0.0';
  private readonly config: AggregationConfig;

  constructor(config: AggregationConfig) {
    this.config = config;
  }

  format(
    input: AggregationInput,
    results: readonly NormalizedResult[],
    status: AggregationStatus,
    statistics: AggregationStatistics,
    retries: readonly RetrySummary[],
  ): AggregatedResponse {
    const completedAt = new Date().toISOString();
    const responseId = buildResponseId(input.executionId, input.plan.planId);
    const warnings: ResultWarning[] = [...this.buildWarnings(input, results, statistics)];
    const errors = this.buildErrors(results);
    const metadata = this.buildMetadata(
      input,
      results,
      status,
      statistics,
      completedAt,
      responseId,
      warnings,
    );
    const outputs = this.buildOutputs(results);

    return {
      responseId,
      executionId: input.executionId,
      planId: input.plan.planId,
      requestId: input.plan.requestId,
      traceId: input.plan.traceId,
      status,
      outputs,
      errors,
      warnings,
      statistics,
      metadata,
      retries,
      completedAt,
    };
  }

  private buildOutputs(results: readonly NormalizedResult[]): readonly AggregatedOutput[] {
    return results
      .filter((result) => result.status === ExecutionStatus.Succeeded && !result.skipped)
      .map((result) => ({
        stepId: result.stepId,
        agentId: result.agentId,
        executionId: result.executionId,
        status: result.status,
        output: result.output,
        metadata: result.metadata,
      }));
  }

  private buildErrors(results: readonly NormalizedResult[]): readonly ResultError[] {
    if (this.config.AGGREGATION_INCLUDE_ERRORS === false) {
      return [];
    }
    return results
      .filter((result) => result.error !== undefined)
      .map((result) => result.error!)
      .sort((a, b) => {
        const stepA = a.stepId ?? '';
        const stepB = b.stepId ?? '';
        return stepA.localeCompare(stepB);
      });
  }

  private buildWarnings(
    input: AggregationInput,
    results: readonly NormalizedResult[],
    statistics: AggregationStatistics,
  ): readonly ResultWarning[] {
    if (this.config.AGGREGATION_INCLUDE_WARNINGS === false) {
      return [];
    }

    const warnings: ResultWarning[] = [];

    for (const execution of input.results) {
      if (execution.state === ExecutionState.Partial) {
        warnings.push({
          code: 'PARTIAL_EXECUTION',
          message: `Execution ${execution.executionId} completed partially`,
        });
      }
      if (execution.state === ExecutionState.TimedOut) {
        warnings.push({
          code: 'EXECUTION_TIMED_OUT',
          message: `Execution ${execution.executionId} exceeded its overall timeout`,
        });
      }
      if (execution.cancellation !== undefined) {
        warnings.push({
          code: 'EXECUTION_CANCELLED',
          message: `Execution ${execution.executionId} was cancelled`,
        });
      }
    }

    for (const result of results) {
      warnings.push(...result.warnings);
    }

    warnings.push(...this.dependencyWarnings(input.plan, results));

    if (statistics.duplicateCount > 0) {
      warnings.push({
        code: 'DUPLICATE_RESULT',
        message: `${statistics.duplicateCount} duplicate result(s) were discarded`,
        details: { duplicateCount: statistics.duplicateCount },
      });
    }

    return deduplicateWarnings(warnings);
  }

  private dependencyWarnings(
    plan: ExecutionPlan,
    results: readonly NormalizedResult[],
  ): readonly ResultWarning[] {
    const byStepId = new Map(results.map((result) => [result.stepId, result]));
    const warnings: ResultWarning[] = [];
    const failed = (status?: ExecutionStatus): boolean =>
      status === ExecutionStatus.Failed || status === ExecutionStatus.TimedOut;

    for (const dependency of plan.dependencies) {
      const dependent = byStepId.get(dependency.stepId);
      const prerequisite = byStepId.get(dependency.dependsOn);

      if (
        dependent !== undefined &&
        prerequisite !== undefined &&
        failed(prerequisite.status) &&
        failed(dependent.status)
      ) {
        warnings.push({
          code: 'DEPENDENCY_FAILED',
          message: `Step ${dependency.stepId} depends on failed prerequisite ${dependency.dependsOn}`,
          stepId: dependency.stepId,
          details: { prerequisiteStepId: dependency.dependsOn, required: dependency.required },
        });
      }
    }

    return warnings;
  }

  private buildMetadata(
    input: AggregationInput,
    results: readonly NormalizedResult[],
    status: AggregationStatus,
    statistics: AggregationStatistics,
    completedAt: string,
    responseId: string,
    warnings: ResultWarning[],
  ): ResultMetadata {
    const agentIds = [...new Set(results.map((result) => result.agentId))].sort();
    const stepIds = [...new Set(results.map((result) => result.stepId))].sort();

    const full: ResultMetadata = {
      responseId,
      executionId: input.executionId,
      planId: input.plan.planId,
      agentIds,
      stepIds,
      status,
      resultCount: results.length,
      totalDurationMs: statistics.totalDurationMs,
      completedAt,
    };

    const serialized = JSON.stringify(full);
    if (serialized.length <= this.config.AGGREGATION_MAX_METADATA_SIZE) {
      return full;
    }

    warnings.push({
      code: 'TRUNCATED_METADATA',
      message: 'Aggregation metadata exceeded the configured size limit and was truncated',
      details: {
        bytes: serialized.length,
        limit: this.config.AGGREGATION_MAX_METADATA_SIZE,
      },
    });

    return {
      responseId,
      executionId: input.executionId,
      planId: input.plan.planId,
      agentIds,
      stepIds: [],
      status,
      resultCount: results.length,
      totalDurationMs: statistics.totalDurationMs,
      completedAt,
    };
  }
}

/** Deterministic response identifier derived from the input (prompt §13/§39). */
export function buildResponseId(executionId: string, planId: string): string {
  return `agg_${executionId}_${planId}`;
}

/** Deduplicates warnings by code + stepId, preserving first occurrence order. */
export function deduplicateWarnings(warnings: readonly ResultWarning[]): readonly ResultWarning[] {
  const seen = new Set<string>();
  const unique: ResultWarning[] = [];

  for (const warning of warnings) {
    const key = `${warning.code}:${warning.stepId ?? ''}:${warning.message}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(warning);
  }

  return unique;
}

export type {
  AggregatedResponse,
  AggregationInput,
  AggregationStatistics,
  AggregationStatus,
  NormalizedResult,
  ResultGroup,
  RetrySummary,
};
