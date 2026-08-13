import { describe, expect, it } from 'vitest';

import {
  AggregationConfigSchema,
  parseAggregationConfig,
  isAggregationFeatureEnabled,
} from '../../../../../src/agents/ag-001-master-orchestrator/aggregation/config/index.js';
import { AggregationConfigError } from '../../../../../src/agents/ag-001-master-orchestrator/aggregation/errors/index.js';

describe('aggregation config', () => {
  it('applies safe defaults', () => {
    const config = parseAggregationConfig({});
    expect(config.AGGREGATION_DEDUPLICATION_ENABLED).toBe(true);
    expect(config.AGGREGATION_STRICT_VALIDATION).toBe(true);
    expect(config.AGGREGATION_INCLUDE_RETRY_HISTORY).toBe(true);
    expect(config.AGGREGATION_INCLUDE_WARNINGS).toBe(true);
    expect(config.AGGREGATION_INCLUDE_ERRORS).toBe(true);
    expect(config.AGGREGATION_MAX_RESULT_COUNT).toBe(100);
    expect(config.AGGREGATION_MAX_METADATA_SIZE).toBe(8_192);
  });

  it('parses overrides from the environment', () => {
    const config = parseAggregationConfig({
      AGGREGATION_DEDUPLICATION_ENABLED: 'false',
      AGGREGATION_STRICT_VALIDATION: 'false',
      AGGREGATION_INCLUDE_RETRY_HISTORY: 'false',
      AGGREGATION_INCLUDE_WARNINGS: 'false',
      AGGREGATION_INCLUDE_ERRORS: 'false',
      AGGREGATION_MAX_RESULT_COUNT: '10',
      AGGREGATION_MAX_METADATA_SIZE: '256',
    });

    expect(config.AGGREGATION_DEDUPLICATION_ENABLED).toBe(false);
    expect(config.AGGREGATION_STRICT_VALIDATION).toBe(false);
    expect(config.AGGREGATION_INCLUDE_RETRY_HISTORY).toBe(false);
    expect(config.AGGREGATION_INCLUDE_WARNINGS).toBe(false);
    expect(config.AGGREGATION_INCLUDE_ERRORS).toBe(false);
    expect(config.AGGREGATION_MAX_RESULT_COUNT).toBe(10);
    expect(config.AGGREGATION_MAX_METADATA_SIZE).toBe(256);
  });

  it('parses raw strings correctly', () => {
    const result = AggregationConfigSchema.safeParse({
      AGGREGATION_MAX_RESULT_COUNT: 5,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a non-positive result count', () => {
    expect(() =>
      parseAggregationConfig({
        AGGREGATION_MAX_RESULT_COUNT: '0',
      }),
    ).toThrow(AggregationConfigError);
  });

  it('rejects an invalid boolean', () => {
    expect(() =>
      parseAggregationConfig({
        AGGREGATION_DEDUPLICATION_ENABLED: 'yes',
      }),
    ).toThrow(AggregationConfigError);
  });

  it('exposes feature flags', () => {
    const config = parseAggregationConfig({});
    expect(isAggregationFeatureEnabled(config, 'deduplication')).toBe(true);
    expect(isAggregationFeatureEnabled(config, 'retryHistory')).toBe(true);
    expect(isAggregationFeatureEnabled(config, 'warnings')).toBe(true);
    expect(isAggregationFeatureEnabled(config, 'errors')).toBe(true);
    expect(isAggregationFeatureEnabled(config, 'unknown')).toBe(true);
  });
});
