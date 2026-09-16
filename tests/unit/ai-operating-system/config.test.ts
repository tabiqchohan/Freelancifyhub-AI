import { describe, expect, it } from 'vitest';

import { DEFAULT_AIOS_CONFIG, parseAiosConfig } from '../../../src/ai-operating-system/config.js';

describe('parseAiosConfig (Sprint 26)', () => {
  it('applies documented defaults when no AIOS env is present', () => {
    const config = parseAiosConfig({});
    expect(config).toEqual(DEFAULT_AIOS_CONFIG);
    expect(config.AIOS_SECRET_SCAN_ENABLED).toBe(true);
  });

  it('parses explicit values and coercion notes for the secret toggle', () => {
    const config = parseAiosConfig({
      AIOS_MAX_TEXT_LENGTH: '100',
      AIOS_REQUEST_TIMEOUT_MS: '500',
      AIOS_SECRET_SCAN_ENABLED: 'false',
      AIOS_EVENT_WINDOW: '10',
    });
    expect(config.AIOS_MAX_TEXT_LENGTH).toBe(100);
    expect(config.AIOS_REQUEST_TIMEOUT_MS).toBe(500);
    expect(config.AIOS_SECRET_SCAN_ENABLED).toBe(false);
    expect(config.AIOS_EVENT_WINDOW).toBe(10);
  });

  it('fails closed on invalid numeric config', () => {
    expect(() => parseAiosConfig({ AIOS_REQUEST_TIMEOUT_MS: '-5' })).toThrow(
      /Invalid AIOS configuration/,
    );
    expect(() => parseAiosConfig({ AIOS_STRUCTURED_DEPTH: '99' })).toThrow(
      /Invalid AIOS configuration/,
    );
  });
});
