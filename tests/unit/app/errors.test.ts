import { describe, expect, it } from 'vitest';

import { DiagnosticError } from '../../../src/app/errors.js';
import { parseCompiledEnv } from '../../../src/app/env.js';

describe('DiagnosticError (app errors)', () => {
  it('defaults the code to COMPOSITION_ERROR', () => {
    const error = new DiagnosticError('bad config');
    expect(error.name).toBe('DiagnosticError');
    expect(error.code).toBe('COMPOSITION_ERROR');
    expect(error.message).toBe('bad config');
  });

  it('carries an explicit code and details', () => {
    const error = new DiagnosticError('oops', {
      code: 'UNSUPPORTED_STORAGE_BACKEND',
      details: { backend: 'unsupported' },
    });
    expect(error.code).toBe('UNSUPPORTED_STORAGE_BACKEND');
    expect(error.details).toEqual({ backend: 'unsupported' });
  });

  it('never carries secrets in the message', () => {
    const error = new DiagnosticError('missing MEMORY_DATABASE_URL');
    expect(error.message).not.toMatch(/(=|:\/\/(\w+):)/);
  });
});

describe('parseCompiledEnv (app env)', () => {
  it('defaults to the in-memory backend when the environment is empty', () => {
    const env = parseCompiledEnv({});
    expect(env.memory.MEMORY_STORAGE_BACKEND).toBe('in-memory');
    expect(env.base).toBeDefined();
  });

  it('reads the configured backend from raw env', () => {
    const env = parseCompiledEnv({ MEMORY_STORAGE_BACKEND: 'durable' } as NodeJS.ProcessEnv);
    expect(env.memory.MEMORY_STORAGE_BACKEND).toBe('durable');
  });
});
