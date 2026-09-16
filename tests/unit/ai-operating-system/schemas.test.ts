import { describe, expect, it } from 'vitest';

import { DEFAULT_AIOS_CONFIG } from '../../../src/ai-operating-system/config.js';
import { AiosErrorCode } from '../../../src/ai-operating-system/errors.js';
import { normalizeTimeoutMs, validateAiosInput } from '../../../src/ai-operating-system/schemas.js';

describe('AIOS schema-bounded input validation (Sprint 26)', () => {
  it('validates and trims a plain text input', () => {
    const input = validateAiosInput({ text: '  create a new project  ' }, DEFAULT_AIOS_CONFIG);
    expect(input.text).toBe('create a new project');
    expect(input.structured).toBeUndefined();
  });

  it('rejects non-object inputs fail-closed', () => {
    expect(() => validateAiosInput('create a project', DEFAULT_AIOS_CONFIG)).toThrow(
      expect.objectContaining({ code: AiosErrorCode.InvalidInput }),
    );
  });

  it('rejects oversized text as PayloadTooLarge', () => {
    const config = { ...DEFAULT_AIOS_CONFIG, AIOS_MAX_TEXT_LENGTH: 10 };
    expect(() => validateAiosInput({ text: 'x'.repeat(11) }, config)).toThrow(
      expect.objectContaining({ code: AiosErrorCode.PayloadTooLarge }),
    );
  });

  it('rejects oversized structured input fail-closed', () => {
    const config = { ...DEFAULT_AIOS_CONFIG, AIOS_STRUCTURED_MAX_BYTES: 100 };
    expect(() =>
      validateAiosInput({ text: 'go', structured: { big: 'y'.repeat(500) } }, config),
    ).toThrow(expect.objectContaining({ code: AiosErrorCode.PayloadTooLarge }));
  });

  it('accepts bounded structured input', () => {
    const input = validateAiosInput(
      { text: 'go', structured: { orgId: 'abc', plan: 'basic' } },
      DEFAULT_AIOS_CONFIG,
    );
    expect(input.structured).toEqual({ orgId: 'abc', plan: 'basic' });
  });

  it('normalizes the per-request timeout knob against the config ceiling', () => {
    expect(normalizeTimeoutMs(undefined, DEFAULT_AIOS_CONFIG)).toBe(
      DEFAULT_AIOS_CONFIG.AIOS_REQUEST_TIMEOUT_MS,
    );
    expect(normalizeTimeoutMs(Number.NaN, DEFAULT_AIOS_CONFIG)).toBe(
      DEFAULT_AIOS_CONFIG.AIOS_REQUEST_TIMEOUT_MS,
    );
    expect(normalizeTimeoutMs(-50, DEFAULT_AIOS_CONFIG)).toBe(1);
    expect(normalizeTimeoutMs(100, DEFAULT_AIOS_CONFIG)).toBe(100);
    expect(
      normalizeTimeoutMs(DEFAULT_AIOS_CONFIG.AIOS_REQUEST_TIMEOUT_MS * 10, DEFAULT_AIOS_CONFIG),
    ).toBe(DEFAULT_AIOS_CONFIG.AIOS_REQUEST_TIMEOUT_MS);
  });
});
