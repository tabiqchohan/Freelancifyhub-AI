import type { Logger } from 'pino';

import { createOrchestratorLogger } from '../../utils/logger.js';
import type { ExecutionMode } from '../../routing/types/index.js';
import { ExecutionMode as ExecutionModeValue } from '../../routing/types/index.js';
import type { AggregationInput, AggregatedResponse, NormalizedResult } from '../types/index.js';
import type {
  ResultNormalizer,
  ResultOrderer,
  StatusCalculator,
  Aggregator,
} from '../interfaces/index.js';
import type { AggregationConfig } from '../config/index.js';
import { aggregationConfig as defaultConfig } from '../config/index.js';
import { validateAggregationInput } from '../validators/index.js';
import { ExecutionResultNormalizer } from '../normalizers/index.js';
import { DeterministicResultOrderer } from '../utils/index.js';
import { DeterministicStatusCalculator } from '../status/index.js';
import { AggregationStatisticsCalculator } from '../statistics/index.js';
import { StructuredResponseFormatter } from '../formatters/index.js';
import { DuplicateResultError } from '../errors/index.js';

/** Options for the shared aggregation service (prompt §15/§40). */
export interface AggregationServiceOptions {
  readonly config?: AggregationConfig;
  readonly normalizer?: ResultNormalizer;
  readonly orderer?: ResultOrderer;
  readonly status?: StatusCalculator;
  readonly logger?: Logger;
}

/**
 * Shared aggregation pipeline used by every strategy (prompt §15/§40).
 * Validate → normalize → order → dedupe → group → status → statistics →
 * retries → format. Deterministic and non-destructive.
 */
export class SharedAggregationService {
  readonly name = 'shared-aggregation-service';
  readonly config: AggregationConfig;
  readonly normalizer: ResultNormalizer;
  private readonly orderer: ResultOrderer;
  private readonly status: StatusCalculator;
  private readonly statistics: AggregationStatisticsCalculator;
  private readonly formatter: StructuredResponseFormatter;
  private readonly logger: Logger;

  constructor(options: AggregationServiceOptions | AggregationConfig = {}) {
    const isBareConfig =
      options !== null &&
      typeof options === 'object' &&
      !('config' in options) &&
      Object.keys(options).some((key) => key.startsWith('AGGREGATION_'));

    const resolved: AggregationServiceOptions = isBareConfig
      ? { config: options as AggregationConfig }
      : (options as AggregationServiceOptions);

    this.config = resolved.config ?? defaultConfig;
    this.normalizer = resolved.normalizer ?? new ExecutionResultNormalizer(this.config);
    this.orderer = resolved.orderer ?? new DeterministicResultOrderer();
    this.status = resolved.status ?? new DeterministicStatusCalculator();
    this.statistics = new AggregationStatisticsCalculator();
    this.formatter = new StructuredResponseFormatter(this.config);
    this.logger = resolved.logger ?? createOrchestratorLogger('aggregation');
  }

  aggregate(input: AggregationInput): AggregatedResponse {
    validateAggregationInput(input, this.config);

    const normalized = this.normalizer.normalize(input);
    const ordered = this.orderer.order(normalized, input.plan);
    const { results, duplicateCount } = this.deduplicate(ordered);
    const status = this.status.calculate(results, input, this.config);
    const statistics = this.statistics.calculate(input, results, duplicateCount);
    const retries = this.config.AGGREGATION_INCLUDE_RETRY_HISTORY ? this.collectRetries(input) : [];

    const response = this.formatter.format(input, results, status, statistics, retries);

    this.logger.info(
      {
        responseId: response.responseId,
        executionId: response.executionId,
        planId: response.planId,
        resultCount: results.length,
        successCount: statistics.successfulSteps,
        failureCount: statistics.failedSteps + statistics.timedOutSteps,
        status: response.status,
        warningCount: statistics.warningCount,
        errorCount: statistics.errorCount,
      },
      'aggregation finished',
    );

    return response;
  }

  /** Collects retry history from execution results (prompt §7/§33). */
  private collectRetries(input: AggregationInput) {
    if (this.normalizer instanceof ExecutionResultNormalizer) {
      return input.results.flatMap((execution) => this.normalizer.retries(execution));
    }
    return [];
  }

  /** Detects and handles duplicate results (prompt §6/§33). */
  private deduplicate(results: readonly NormalizedResult[]): {
    readonly results: readonly NormalizedResult[];
    readonly duplicateCount: number;
  } {
    if (this.config.AGGREGATION_DEDUPLICATION_ENABLED === false) {
      return { results, duplicateCount: 0 };
    }

    const seen = new Set<string>();
    const unique: NormalizedResult[] = [];
    let duplicateCount = 0;

    for (const result of results) {
      if (seen.has(result.key)) {
        if (this.config.AGGREGATION_STRICT_VALIDATION) {
          throw new DuplicateResultError(
            `Duplicate result for execution ${result.executionId}, step ${result.stepId}`,
            { details: { executionId: result.executionId, stepId: result.stepId } },
          );
        }
        duplicateCount += 1;
        continue;
      }
      seen.add(result.key);
      unique.push(result);
    }

    return { results: unique, duplicateCount };
  }
}

/** Base class for the interface-driven aggregation strategies (prompt §15). */
abstract class BaseResultAggregator implements Aggregator {
  abstract readonly name: string;
  abstract readonly mode: ExecutionMode;
  private readonly service: SharedAggregationService;

  constructor(serviceOrConfig?: SharedAggregationService | AggregationConfig) {
    this.service =
      serviceOrConfig instanceof SharedAggregationService
        ? serviceOrConfig
        : new SharedAggregationService({ config: serviceOrConfig });
  }

  aggregate(input: AggregationInput): AggregatedResponse {
    return this.service.aggregate(input);
  }
}

/** Aggregates a single execution result (prompt §5/§40). */
export class SingleResultAggregator extends BaseResultAggregator {
  readonly name = 'single-result-aggregator';
  readonly mode = ExecutionModeValue.Single;
}

/** Aggregates results from a sequential execution plan. */
export class SequentialResultAggregator extends BaseResultAggregator {
  readonly name = 'sequential-result-aggregator';
  readonly mode = ExecutionModeValue.Sequential;
}

/** Aggregates results from a parallel execution plan. */
export class ParallelResultAggregator extends BaseResultAggregator {
  readonly name = 'parallel-result-aggregator';
  readonly mode = ExecutionModeValue.Parallel;
}

/** Aggregates results from a conditional execution plan. */
export class ConditionalResultAggregator extends BaseResultAggregator {
  readonly name = 'conditional-result-aggregator';
  readonly mode = ExecutionModeValue.Conditional;
}

/** Aggregates results from a hybrid execution plan. */
export class HybridResultAggregator extends BaseResultAggregator {
  readonly name = 'hybrid-result-aggregator';
  readonly mode = ExecutionModeValue.Hybrid;
}

/** Resolves the aggregation strategy for an execution mode (prompt §15). */
export function resolveAggregationStrategy(
  mode: ExecutionMode,
  service?: SharedAggregationService | AggregationConfig,
): Aggregator {
  switch (mode) {
    case ExecutionModeValue.Single:
      return new SingleResultAggregator(service);
    case ExecutionModeValue.Sequential:
      return new SequentialResultAggregator(service);
    case ExecutionModeValue.Parallel:
      return new ParallelResultAggregator(service);
    case ExecutionModeValue.Conditional:
      return new ConditionalResultAggregator(service);
    case ExecutionModeValue.Hybrid:
      return new HybridResultAggregator(service);
    default:
      return new SingleResultAggregator(service);
  }
}

export type {
  AggregationInput,
  AggregatedResponse,
  NormalizedResult,
  AggregationConfig,
  ResultNormalizer,
  ResultOrderer,
  StatusCalculator,
};
