/**
 * Fail-closed test-database safety guard (Sprint 37 / prompts13 Blocker 2).
 *
 * Sprint 36 discovered `int-kn-*` rows inside the live Neon database, which
 * proved that the integration suites had been running against production. The
 * root cause was that those suites read the runtime variable
 * `MEMORY_DATABASE_URL`, which is populated with the production connection
 * string in a developer's local `.env`.
 *
 * This guard is the fix: integration suites must read the dedicated
 * `AIOS_TEST_DATABASE_URL` variable and prove, in code, that the target is an
 * isolated local test database.
 *
 * Rules (all deliberate):
 *  - ALLOWLIST, not denylist: only loopback hosts are accepted, so the next
 *    managed-postgres provider to appear is rejected by default.
 *  - FAIL CLOSED on missing, empty, unparseable, or non-PostgreSQL input.
 *  - NEVER falls back to `MEMORY_DATABASE_URL`; a test run with no dedicated
 *    test URL must skip, not quietly borrow the production target.
 *  - Never includes the connection string in an error, so credentials cannot
 *    leak into CI logs.
 */

/** Dedicated variable that integration suites are allowed to use. */
export const AIOS_TEST_DATABASE_URL_ENV = 'AIOS_TEST_DATABASE_URL';

/** The runtime variable that must never be used by tests. */
export const PRODUCTION_DATABASE_URL_ENV = 'MEMORY_DATABASE_URL';

const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const ALLOWED_SCHEMES = new Set(['postgres:', 'postgresql:']);

const FORBIDDEN_MARKERS = [
  'neon.tech',
  'neon.build',
  'supabase',
  'amazonaws.com',
  'rds.amazonaws',
  'cloudsql',
  'azure.com',
  'database.windows.net',
  'postgres.database.azure.com',
];

const PRODUCTION_NAME_TOKENS = ['prod', 'production', 'live', 'primary'];

export class UnsafeTestDatabaseError extends Error {
  readonly code = 'UNSAFE_TEST_DATABASE' as const;

  constructor(message: string) {
    super(message);
    this.name = 'UnsafeTestDatabaseError';
  }
}

export interface TestDatabaseInfo {
  host: string;
  port: number | null;
  database: string;
}

export interface ClassifyResult {
  ok: boolean;
  reason: string;
  info?: TestDatabaseInfo;
}

/** Classifies a connection string without throwing. */
export function classifyTestDatabaseUrl(rawUrl: string | undefined | null): ClassifyResult {
  const url = typeof rawUrl === 'string' ? rawUrl.trim() : '';

  if (url.length === 0) {
    return {
      ok: false,
      reason:
        `No test database URL was configured. Set ${AIOS_TEST_DATABASE_URL_ENV} to an isolated ` +
        'local PostgreSQL database. This guard never falls back to ' +
        `${PRODUCTION_DATABASE_URL_ENV}.`,
    };
  }

  const lowered = url.toLowerCase();
  const marker = FORBIDDEN_MARKERS.find((m) => lowered.includes(m));
  if (marker !== undefined) {
    return {
      ok: false,
      reason: `The configured test database URL matches the managed-database marker "${marker}".`,
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'The configured test database URL could not be parsed.' };
  }

  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    return {
      ok: false,
      reason:
        'The configured test database URL must use a postgres:// or postgresql:// scheme ' +
        `(got "${parsed.protocol}").`,
    };
  }

  if (!ALLOWED_HOSTS.has(parsed.hostname)) {
    return {
      ok: false,
      reason:
        `The configured test database host "${parsed.hostname}" is not a loopback address. ` +
        'Tests may only target an isolated local PostgreSQL instance.',
    };
  }

  const database = parsed.pathname.replace(/^\//, '');
  if (database.length === 0) {
    return { ok: false, reason: 'The configured test database URL does not name a database.' };
  }

  const loweredDb = database.toLowerCase();
  const productionToken = PRODUCTION_NAME_TOKENS.find((t) => loweredDb.includes(t));
  if (productionToken !== undefined) {
    return {
      ok: false,
      reason:
        `The configured test database name "${database}" looks production-like ` +
        `(matched "${productionToken}").`,
    };
  }

  return {
    ok: true,
    reason: 'Isolated local test database.',
    info: {
      host: parsed.hostname,
      port: parsed.port.length > 0 ? Number(parsed.port) : null,
      database,
    },
  };
}

export interface AssertTestDatabaseOptions {
  url: string | undefined | null;
  purpose: string;
  requireDatabaseNameContains?: string;
}

/** Returns the target when safe, otherwise throws {@link UnsafeTestDatabaseError}. */
export function assertTestDatabase(options: AssertTestDatabaseOptions): TestDatabaseInfo {
  const { url, purpose, requireDatabaseNameContains } = options;
  const result = classifyTestDatabaseUrl(url);

  if (!result.ok || result.info === undefined) {
    throw new UnsafeTestDatabaseError(
      `Refusing to run ${purpose}: ${result.reason} ` +
        'See docs/final-launch-readiness.md (Blocker 2 remediation).',
    );
  }

  if (requireDatabaseNameContains !== undefined) {
    const needle = requireDatabaseNameContains.toLowerCase();
    if (!result.info.database.toLowerCase().includes(needle)) {
      throw new UnsafeTestDatabaseError(
        `Refusing to run ${purpose}: the configured test database name must contain ` +
          `"${needle}" to prove it is a dedicated test database ` +
          `(got "${result.info.database}").`,
      );
    }
  }

  return result.info;
}

export interface ResolveTestDatabaseResult {
  /** True when a dedicated, guard-approved test database is configured. */
  enabled: boolean;
  /** Approved connection string; undefined when `enabled` is false. */
  url?: string;
  info?: TestDatabaseInfo;
  /** Credential-free explanation, suitable for test output. */
  reason: string;
}

/**
 * Resolves the dedicated test database for a suite.
 *
 * Unlike {@link assertTestDatabase} this never throws for an *absent* value,
 * because the documented behaviour of the integration suites is to self-skip
 * when no database is available (CI has no PostgreSQL service). It does still
 * throw when a value IS configured but unsafe, so a misconfigured run fails
 * loudly instead of silently skipping or writing to production.
 */
export function resolveTestDatabase(purpose: string): ResolveTestDatabaseResult {
  const raw = process.env[AIOS_TEST_DATABASE_URL_ENV];
  if (raw === undefined || raw.trim().length === 0) {
    return {
      enabled: false,
      reason:
        `${AIOS_TEST_DATABASE_URL_ENV} is not set; skipping ${purpose}. ` +
        `Tests never fall back to ${PRODUCTION_DATABASE_URL_ENV}.`,
    };
  }

  const info = assertTestDatabase({ url: raw, purpose });
  return { enabled: true, url: raw.trim(), info, reason: 'Isolated local test database.' };
}
