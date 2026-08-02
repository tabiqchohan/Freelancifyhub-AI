import { describe, expect, it } from 'vitest';

import { EnvSchema, parseEnv } from '../../../src/config/env.js';

describe('EnvSchema', () => {
  it('applies defaults when no values are provided', () => {
    const parsed = EnvSchema.parse({});

    expect(parsed.NODE_ENV).toBe('development');
    expect(parsed.HOST).toBe('0.0.0.0');
    expect(parsed.PORT).toBe(3000);
    expect(parsed.LOG_LEVEL).toBe('info');
    expect(parsed.LOG_PRETTY).toBe(false);
  });

  it('parses explicit string values', () => {
    const parsed = EnvSchema.parse({
      NODE_ENV: 'production',
      PORT: '8080',
      LOG_PRETTY: 'true',
    });

    expect(parsed.NODE_ENV).toBe('production');
    expect(parsed.PORT).toBe(8080);
    expect(parsed.LOG_PRETTY).toBe(true);
  });

  it('rejects an unknown NODE_ENV', () => {
    const result = EnvSchema.safeParse({ NODE_ENV: 'staging' });

    expect(result.success).toBe(false);
  });
});

describe('parseEnv', () => {
  it('parses a valid process environment', () => {
    const env = parseEnv({
      NODE_ENV: 'production',
      PORT: '8080',
      LOG_PRETTY: 'false',
    } as NodeJS.ProcessEnv);

    expect(env.NODE_ENV).toBe('production');
    expect(env.PORT).toBe(8080);
    expect(env.LOG_PRETTY).toBe(false);
  });

  it('throws on an invalid value', () => {
    expect(() => parseEnv({ PORT: 'not-a-number' } as NodeJS.ProcessEnv)).toThrow();
  });
});
