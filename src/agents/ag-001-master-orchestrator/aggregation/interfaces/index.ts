import type {
  AggregationInput,
  AggregationStatistics,
  AggregationStatus,
  AggregatedResponse,
  NormalizedResult,
  ResultGroup,
  RetrySummary,
} from '../types/index.js';
import type { AggregationConfig } from '../config/index.js';
import type { ExecutionPlan } from '../../planning/types/index.js';
import type { ExecutionResult } from '../../execution/types/index.js';

/** Contract every result normalizer satisfies (prompt §2/§30). */
export interface ResultNormalizer {
  readonly name: string;
  normalize(input: AggregationInput): readonly NormalizedResult[];
  /** Reconstructs retry history from an execution result (prompt §7/§33). */
  retries(execution: ExecutionResult): readonly RetrySummary[];
}

/** Deterministic ordering of normalized results (prompt §3/§31). */
export interface ResultOrderer {
  order(results: readonly NormalizedResult[], plan?: ExecutionPlan): readonly NormalizedResult[];
}

/** Deterministic grouping of normalized results (prompt §4/§32). */
export interface ResultGrouper {
  group(
    results: readonly NormalizedResult[],
  ): Readonly<Partial<Record<ResultGroup, readonly NormalizedResult[]>>>;
}

/** Aggregates structured outputs preserving origin (prompt §5/§34). */
export interface OutputAggregator {
  aggregate(results: readonly NormalizedResult[]): readonly unknown[];
}

/** Calculates the deterministic final status (prompt §9/§33). */
export interface StatusCalculator {
  calculate(
    results: readonly NormalizedResult[],
    input: AggregationInput,
    config?: AggregationConfig,
  ): AggregationStatus;
}

/** Formats an aggregated response (prompt §14/§39). */
export interface ResponseFormatter {
  readonly version: string;
  format(
    input: AggregationInput,
    results: readonly NormalizedResult[],
    status: AggregationStatus,
    statistics: AggregationStatistics,
    retries: readonly RetrySummary[],
  ): AggregatedResponse;
}

/** Contract every aggregation strategy satisfies (prompt §15/§40). */
export interface Aggregator {
  readonly name: string;
  readonly mode: string;
  aggregate(input: AggregationInput): AggregatedResponse;
}

export type {
  AggregationInput,
  AggregationStatistics,
  AggregationStatus,
  AggregatedResponse,
  NormalizedResult,
  ResultGroup,
  RetrySummary,
  AggregationConfig,
};
