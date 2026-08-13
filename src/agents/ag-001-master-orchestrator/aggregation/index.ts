export * from './errors/index.js';
export * from './types/index.js';

export {
  AggregationConfigSchema,
  parseAggregationConfig,
  aggregationConfig,
  isAggregationFeatureEnabled,
} from './config/index.js';
export type { AggregationConfig } from './config/index.js';

export type {
  ResultNormalizer,
  ResultOrderer,
  ResultGrouper,
  OutputAggregator,
  StatusCalculator,
  ResponseFormatter,
  Aggregator,
} from './interfaces/index.js';

export { validateAggregationInput, validateExecutionResult } from './validators/index.js';

export { ExecutionResultNormalizer, groupForStatus, toResultError } from './normalizers/index.js';

export {
  DeterministicResultOrderer,
  DefaultResultGrouper,
  sanitizeRecord,
  isSensitiveKey,
  RESULT_GROUP_ORDER,
} from './utils/index.js';

export {
  DeterministicStatusCalculator,
  executionStateToAggregationStatus,
} from './status/index.js';

export { AggregationStatisticsCalculator } from './statistics/index.js';

export {
  StructuredResponseFormatter,
  buildResponseId,
  deduplicateWarnings,
} from './formatters/index.js';

export {
  SharedAggregationService,
  SingleResultAggregator,
  SequentialResultAggregator,
  ParallelResultAggregator,
  ConditionalResultAggregator,
  HybridResultAggregator,
  resolveAggregationStrategy,
} from './aggregators/index.js';
export type { AggregationServiceOptions } from './aggregators/index.js';
