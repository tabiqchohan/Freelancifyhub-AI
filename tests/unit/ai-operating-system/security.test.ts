import { describe, expect, it } from 'vitest';

import { AiosErrorCode } from '../../../src/ai-operating-system/errors.js';
import {
  assertNoSecrets,
  isAdminRole,
  redactSecrets,
} from '../../../src/ai-operating-system/security.js';

describe('AIOS boundary security (Sprint 26)', () => {
  it('passes clean text through the inbound scan', () => {
    expect(() => assertNoSecrets('create a new project', true)).not.toThrow();
  });

  it('rejects known secret shapes fail-closed when enabled', () => {
    expect(() => assertNoSecrets('key sk-ABCDEFGHIJKLMNOPQRST here', true)).toThrow(
      expect.objectContaining({ code: AiosErrorCode.SecretDetected }),
    );
    expect(() => assertNoSecrets('token AKIAABCDEFGHIJKLMNOP here', true)).toThrow(
      expect.objectContaining({ code: AiosErrorCode.SecretDetected }),
    );
  });

  it('skips the scan when disabled (explicit operator choice)', () => {
    expect(() => assertNoSecrets('sk-ABCDEFGHIJKLMNOPQRST', false)).not.toThrow();
  });

  it('redacts secrets from composed output and leaves clean text untouched', () => {
    expect(redactSecrets('api_key=1234567890abcdefghij', true)).toBe('[REDACTED]');
    expect(redactSecrets('create a new project', true)).toBe('create a new project');
    expect(redactSecrets('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ', false)).toBe(
      'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    );
  });

  it('identifies admin roles for privilege gating', () => {
    expect(isAdminRole('Admin')).toBe(true);
    expect(isAdminRole('System')).toBe(true);
    expect(isAdminRole('Freelancer')).toBe(false);
    expect(isAdminRole('Guest')).toBe(false);
  });
});
