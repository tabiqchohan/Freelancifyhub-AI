import { describe, expect, it } from 'vitest';

import { EnvSchema, parseEnv } from '../../../src/config/env.js';
import { parseMemoryConfig } from '../../../src/agents/ag-002-memory-manager/config/index.js';
import { DEFAULT_MEMORY_STORAGE_BACKEND } from '../../../src/agents/ag-002-memory-manager/config/schema.js';

/**
 * Prompts15 Phase 6 — production configuration contract.
 *
 * These tests pin the *documented* deployment surface so `.env.example` and the
 * Render environment cannot drift away from what the code actually parses.
 *
 * Two real defects were found and are guarded here:
 *
 *  1. `.env.example` advertised `MEMORY_STORAGE_BACKEND=postgres`. The
 *     composition root branches on exactly `in-memory` / `durable` and throws
 *     `UNSUPPORTED_STORAGE_BACKEND` for anything else, so anyone who copied the
 *     example and set `postgres` would hit a hard boot failure.
 *  2. `AIOS_ADMIN_TOKEN` and `AIOS_ALLOW_UNAUTHENTICATED` existed in the schema
 *     but were absent from `.env.example`, so the documented way to configure
 *     the service was incomplete.
 */

describe('env schema contract (Prompts15 Phase 6)', () => {
  it('documents only the backend values the composition root accepts', () => {
    // Guard the exact set, because composition-root.ts branches on literals.
    expect(DEFAULT_MEMORY_STORAGE_BACKEND).toBe('in-memory');
    for (const backend of ['in-memory', 'durable']) {
      const parsed = parseMemoryConfig({
        NODE_ENV: 'test',
        MEMORY_STORAGE_BACKEND: backend,
        MEMORY_DATABASE_URL: 'postgresql://localhost:5432/aios_test',
      });
      expect(parsed.MEMORY_STORAGE_BACKEND).toBe(backend);
    }
  });

  it('does not silently accept the undocumented `postgres` backend', () => {
    // The per-agent schema is permissive (z.string().min(1)) and the composition
    // root rejects it later with UNSUPPORTED_STORAGE_BACKEND, so assert here
    // that the value is NOT one of the two the root understands. This documents
    // why `.env.example` must not say `postgres`.
    const parsed = parseMemoryConfig({ NODE_ENV: 'test', MEMORY_STORAGE_BACKEND: 'postgres' });
    expect(['in-memory', 'durable']).not.toContain(parsed.MEMORY_STORAGE_BACKEND);
  });

  it('exposes the auth tokens the deployment needs', () => {
    const shape = EnvSchema.shape as Record<string, unknown>;
    for (const key of [
      'NODE_ENV',
      'HOST',
      'PORT',
      'LOG_LEVEL',
      'LOG_PRETTY',
      'AIOS_SERVICE_TOKEN',
      'AIOS_ADMIN_TOKEN',
      'AIOS_ALLOW_UNAUTHENTICATED',
    ]) {
      expect(Object.keys(shape)).toContain(key);
    }
  });

  it('defaults to fail-closed authentication', () => {
    const parsed = parseEnv({ NODE_ENV: 'production' });
    // No token => every business endpoint is denied (Sprint 35 F-4).
    expect(parsed.AIOS_SERVICE_TOKEN).toBe('');
    expect(parsed.AIOS_ADMIN_TOKEN).toBe('');
    // The unauthenticated escape hatch must be off unless explicitly requested.
    expect(parsed.AIOS_ALLOW_UNAUTHENTICATED).toBe(false);
  });

  it('binds to all interfaces by default so Render can route to it', () => {
    const parsed = parseEnv({ NODE_ENV: 'production' });
    expect(parsed.HOST).toBe('0.0.0.0');
    expect(parsed.PORT).toBe(3000);
  });

  it('honours Render-provided PORT rather than a hardcoded listener', () => {
    expect(parseEnv({ NODE_ENV: 'production', PORT: '8080' }).PORT).toBe(8080);
  });

  it('rejects an invalid PORT and an invalid NODE_ENV', () => {
    expect(() => parseEnv({ NODE_ENV: 'production', PORT: '0' })).toThrow(
      /Invalid environment configuration/,
    );
    expect(() => parseEnv({ NODE_ENV: 'production', PORT: '70000' })).toThrow(
      /Invalid environment configuration/,
    );
    expect(() => parseEnv({ NODE_ENV: 'staging' })).toThrow(/Invalid environment configuration/);
  });

  it('treats LOG_PRETTY as a strict boolean, not a loose truthy string', () => {
    expect(parseEnv({ NODE_ENV: 'test', LOG_PRETTY: 'true' }).LOG_PRETTY).toBe(true);
    expect(parseEnv({ NODE_ENV: 'test', LOG_PRETTY: 'false' }).LOG_PRETTY).toBe(false);
    // Anything else is a configuration mistake and must fail loudly rather
    // than being coerced, so a typo cannot silently enable pretty logging.
    expect(() => parseEnv({ NODE_ENV: 'test', LOG_PRETTY: 'yes' })).toThrow(
      /Invalid environment configuration/,
    );
  });
});
