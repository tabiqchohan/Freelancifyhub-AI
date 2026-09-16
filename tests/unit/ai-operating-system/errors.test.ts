import { describe, expect, it } from 'vitest';

import {
  AiosError,
  AiosErrorCode,
  AIOS_ERROR_HTTP_STATUS,
  isAiosError,
  toAiosError,
} from '../../../src/ai-operating-system/errors.js';

describe('AiosError surface (Sprint 26)', () => {
  it('maps every error code to a stable HTTP status', () => {
    expect(AIOS_ERROR_HTTP_STATUS[AiosErrorCode.InvalidInput]).toBe(400);
    expect(AIOS_ERROR_HTTP_STATUS[AiosErrorCode.PayloadTooLarge]).toBe(413);
    expect(AIOS_ERROR_HTTP_STATUS[AiosErrorCode.UnknownIntent]).toBe(422);
    expect(AIOS_ERROR_HTTP_STATUS[AiosErrorCode.UnauthorizedScope]).toBe(403);
    expect(AIOS_ERROR_HTTP_STATUS[AiosErrorCode.RouteUnavailable]).toBe(503);
    expect(AIOS_ERROR_HTTP_STATUS[AiosErrorCode.SecretDetected]).toBe(400);
    expect(AIOS_ERROR_HTTP_STATUS[AiosErrorCode.IdempotencyConflict]).toBe(409);
    expect(AIOS_ERROR_HTTP_STATUS[AiosErrorCode.DeadlineExceeded]).toBe(504);
    expect(AIOS_ERROR_HTTP_STATUS[AiosErrorCode.Cancelled]).toBe(499);
    expect(AIOS_ERROR_HTTP_STATUS[AiosErrorCode.Internal]).toBe(500);
  });

  it('isAiosError distinguishes typed failures', () => {
    const error = new AiosError(AiosErrorCode.UnknownIntent, 'no intent');
    expect(isAiosError(error)).toBe(true);
    expect(isAiosError(new Error('boom'))).toBe(false);
  });

  it('toAiosError passes through and fills unknown failures', () => {
    const typed = new AiosError(AiosErrorCode.SecretDetected, 'secret');
    expect(toAiosError(typed)).toBe(typed);
    const mapped = toAiosError(new Error('boom'));
    expect(mapped).toBeInstanceOf(AiosError);
    expect(mapped.code).toBe(AiosErrorCode.Internal);
    const unknown = toAiosError('raw string');
    expect(unknown.code).toBe(AiosErrorCode.Internal);
    expect(unknown.message).toBe('Unclassified AIOS failure');
  });
});
