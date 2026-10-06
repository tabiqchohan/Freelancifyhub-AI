/**
 * Regression tests for the fail-closed test-database guard (prompts13 Blocker 2).
 *
 * The most important case here is the last group: a suite that has no dedicated
 * test URL must SKIP, never silently borrow the production
 * `MEMORY_DATABASE_URL`. That silent fallback is exactly what produced the
 * `int-kn-*` rows found in the live database during Sprint 36.
 */
import { describe, it, expect, afterEach } from 'vitest';

import {
  AIOS_TEST_DATABASE_URL_ENV,
  PRODUCTION_DATABASE_URL_ENV,
  UnsafeTestDatabaseError,
  assertTestDatabase,
  classifyTestDatabaseUrl,
  resolveTestDatabase,
} from '../../../src/lib/test-database-guard.js';

const originalTestUrl = process.env[AIOS_TEST_DATABASE_URL_ENV];
const originalProdUrl = process.env[PRODUCTION_DATABASE_URL_ENV];

afterEach(() => {
  if (originalTestUrl === undefined) {
    delete process.env[AIOS_TEST_DATABASE_URL_ENV];
  } else {
    process.env[AIOS_TEST_DATABASE_URL_ENV] = originalTestUrl;
  }
  if (originalProdUrl === undefined) {
    delete process.env[PRODUCTION_DATABASE_URL_ENV];
  } else {
    process.env[PRODUCTION_DATABASE_URL_ENV] = originalProdUrl;
  }
});

describe('classifyTestDatabaseUrl', () => {
  it('accepts an isolated loopback PostgreSQL URL', () => {
    const result = classifyTestDatabaseUrl('postgresql://u:synthetic@127.0.0.1:55432/aios_test');
    expect(result.ok).toBe(true);
    expect(result.info?.host).toBe('127.0.0.1');
    expect(result.info?.port).toBe(55432);
    expect(result.info?.database).toBe('aios_test');
  });

  it('rejects a missing or empty URL instead of defaulting', () => {
    for (const value of [undefined, null, '', '  ']) {
      const result = classifyTestDatabaseUrl(value);
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/No test database URL/i);
    }
  });

  it('rejects the live Neon host', () => {
    const result = classifyTestDatabaseUrl(
      'postgresql://u:secret@ep-abc-123-pooler.c-2.us-east-2.aws.neon.tech/neondb',
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/neon\.tech/i);
  });

  it('rejects other managed-postgres providers', () => {
    for (const url of [
      'postgresql://u:p@db.supabase.co:5432/postgres',
      'postgresql://u:p@db.abc.us-east-1.rds.amazonaws.com:5432/app',
      'postgresql://u:p@project.cloudsql.google.com:5432/app',
    ]) {
      expect(classifyTestDatabaseUrl(url).ok).toBe(false);
    }
  });

  it('rejects any non-loopback host', () => {
    expect(classifyTestDatabaseUrl('postgresql://u:p@db.example.com:5432/app').ok).toBe(false);
  });

  it('rejects a production-looking database name on a local host', () => {
    for (const db of ['aios_prod', 'production', 'app_live', 'db_primary']) {
      expect(classifyTestDatabaseUrl(`postgresql://u:p@127.0.0.1:5432/${db}`).ok).toBe(false);
    }
  });

  it('rejects a non-postgres scheme and an unparseable URL', () => {
    expect(classifyTestDatabaseUrl('mysql://127.0.0.1:3306/aios_test').ok).toBe(false);
    expect(classifyTestDatabaseUrl('nonsense').ok).toBe(false);
  });

  it('never echoes credentials in its rejection message', () => {
    const result = classifyTestDatabaseUrl(
      'postgresql://leaked_user:super_secret_value@db.example.com:5432/prod_db',
    );
    expect(JSON.stringify(result)).not.toContain('super_secret_value');
    expect(JSON.stringify(result)).not.toContain('leaked_user');
  });
});

describe('assertTestDatabase', () => {
  it('returns the target for a safe isolated database', () => {
    const info = assertTestDatabase({
      url: 'postgresql://u:p@127.0.0.1:55432/aios_test',
      purpose: 'AG-003 suite',
    });
    expect(info.database).toBe('aios_test');
  });

  it('throws, naming the failing purpose, for an unsafe target', () => {
    expect(() =>
      assertTestDatabase({
        url: 'postgresql://u:p@10.0.0.5:5432/aios_test',
        purpose: 'AG-004 suite',
      }),
    ).toThrow(/AG-004 suite/);
  });

  it('enforces an explicit test-database name when required', () => {
    expect(() =>
      assertTestDatabase({
        url: 'postgresql://u:p@127.0.0.1:55432/aios_scratch',
        purpose: 'namespace suite',
        requireDatabaseNameContains: 'test',
      }),
    ).toThrow(UnsafeTestDatabaseError);
  });
});

describe('resolveTestDatabase', () => {
  it('enables the suite when a dedicated test URL is present and safe', () => {
    process.env[AIOS_TEST_DATABASE_URL_ENV] = 'postgresql://u:p@127.0.0.1:55432/aios_test';
    const result = resolveTestDatabase('namespace suite');
    expect(result.enabled).toBe(true);
    expect(result.url).toBe('postgresql://u:p@127.0.0.1:55432/aios_test');
  });

  it('disables the suite when no dedicated test URL is set', () => {
    delete process.env[AIOS_TEST_DATABASE_URL_ENV];
    const result = resolveTestDatabase('namespace suite');
    expect(result.enabled).toBe(false);
    expect(result.url).toBeUndefined();
    expect(result.reason).toMatch(/skipping/i);
  });

  it('NEVER falls back to the production variable when the test URL is absent', () => {
    delete process.env[AIOS_TEST_DATABASE_URL_ENV];
    process.env[PRODUCTION_DATABASE_URL_ENV] =
      'postgresql://u:p@ep-abc-123-pooler.c-2.us-east-2.aws.neon.tech/neondb';
    const result = resolveTestDatabase('namespace suite');
    expect(result.enabled).toBe(false);
    expect(result.url).toBeUndefined();
  });

  it('fails loudly, rather than skipping, when a configured test URL is unsafe', () => {
    process.env[AIOS_TEST_DATABASE_URL_ENV] =
      'postgresql://u:p@ep-abc-123-pooler.c-2.us-east-2.aws.neon.tech/neondb';
    expect(() => resolveTestDatabase('namespace suite')).toThrow(UnsafeTestDatabaseError);
  });
});
