import { describe, expect, it } from 'vitest';

import { IntentConfigSchema } from '../../../../../src/agents/ag-001-master-orchestrator/intent/config.js';
import { intentConfig } from '../../../../../src/agents/ag-001-master-orchestrator/intent/config.js';
import { parseIntentConfig } from '../../../../../src/agents/ag-001-master-orchestrator/intent/config.js';
import { ConfigurationError } from '../../../../../src/agents/ag-001-master-orchestrator/errors/index.js';

describe('intent config', () => {
  it('applies safe default thresholds and features', () => {
    const config = parseIntentConfig({});

    expect(config.INTENT_HIGH_THRESHOLD).toBe(0.8);
    expect(config.INTENT_LOW_THRESHOLD).toBe(0.55);
    expect(config.INTENT_FALLBACK_CONFIDENCE).toBe(0.1);
    expect(config.INTENT_MAX_CANDIDATES).toBe(3);
    expect(config.INTENT_MULTI_INTENT_ENABLED).toBe(true);
    expect(config.INTENT_ROLE_FILTERING_ENABLED).toBe(true);
  });

  it('honours explicit environment overrides', () => {
    const config = parseIntentConfig({
      INTENT_HIGH_THRESHOLD: '0.9',
      INTENT_LOW_THRESHOLD: '0.6',
      INTENT_MAX_CANDIDATES: '5',
      INTENT_MULTI_INTENT_ENABLED: 'false',
    });

    expect(config.INTENT_HIGH_THRESHOLD).toBe(0.9);
    expect(config.INTENT_LOW_THRESHOLD).toBe(0.6);
    expect(config.INTENT_MAX_CANDIDATES).toBe(5);
    expect(config.INTENT_MULTI_INTENT_ENABLED).toBe(false);
  });

  it('rejects out-of-range thresholds', () => {
    expect(() => parseIntentConfig({ INTENT_LOW_THRESHOLD: '1.5' })).toThrowError(
      ConfigurationError,
    );
  });

  it('exports a parsed singleton', () => {
    expect(intentConfig).toBeDefined();
    expect(IntentConfigSchema).toBeDefined();
  });
});
