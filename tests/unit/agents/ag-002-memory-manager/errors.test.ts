import { describe, expect, it } from 'vitest';

import {
  MemoryAccessDeniedError,
  MemoryConfigurationError,
  MemoryConflictError,
  MemoryError,
  MemoryLifecycleTransitionError,
  MemoryNotFoundError,
  MemoryRetentionError,
  MemoryRetrievalError,
  MemoryStorageError,
  MemoryValidationError,
} from '../../../../src/agents/ag-002-memory-manager/errors/index.js';

const errorTypes = [
  MemoryValidationError,
  MemoryConfigurationError,
  MemoryNotFoundError,
  MemoryAccessDeniedError,
  MemoryLifecycleTransitionError,
  MemoryRetentionError,
  MemoryStorageError,
  MemoryRetrievalError,
  MemoryConflictError,
];

describe('MemoryError - hierarchy shape', () => {
  it('every error extends the MemoryError base', () => {
    for (const Type of errorTypes) {
      const error = new Type('boom');
      expect(error).toBeInstanceOf(MemoryError);
      expect(error).toBeInstanceOf(Type);
      expect(error.name).toBe(Type.name);
    }
  });

  it('carries a message, code and non-retryable default', () => {
    const error = new MemoryValidationError('bad input');
    expect(error.message).toBe('bad input');
    expect(error.code).toBe('MEMORY_VALIDATION_ERROR');
    expect(error.retryable).toBe(false);
    expect(error.details).toBeUndefined();
  });

  it('exposes safe details without leaking secrets', () => {
    const error = new MemoryAccessDeniedError('denied', {
      details: { namespace: 'user:1', permission: 'READ' },
    });
    expect(error.details).toEqual({ namespace: 'user:1', permission: 'READ' });
    expect(JSON.stringify(error.details)).not.toContain('secret');
  });
});

describe('MemoryError - specific codes', () => {
  it('assigns the expected default codes', () => {
    expect(new MemoryValidationError('x').code).toBe('MEMORY_VALIDATION_ERROR');
    expect(new MemoryConfigurationError('x').code).toBe('MEMORY_CONFIGURATION_ERROR');
    expect(new MemoryNotFoundError('x').code).toBe('MEMORY_NOT_FOUND_ERROR');
    expect(new MemoryAccessDeniedError('x').code).toBe('MEMORY_ACCESS_DENIED_ERROR');
    expect(new MemoryLifecycleTransitionError('x').code).toBe('MEMORY_LIFECYCLE_TRANSITION_ERROR');
    expect(new MemoryRetentionError('x').code).toBe('MEMORY_RETENTION_ERROR');
    expect(new MemoryStorageError('x').code).toBe('MEMORY_STORAGE_ERROR');
    expect(new MemoryRetrievalError('x').code).toBe('MEMORY_RETRIEVAL_ERROR');
    expect(new MemoryConflictError('x').code).toBe('MEMORY_CONFLICT_ERROR');
  });

  it('marks storage errors retryable and others not', () => {
    expect(new MemoryStorageError('x').retryable).toBe(true);
    expect(new MemoryConflictError('x').retryable).toBe(false);
    expect(new MemoryNotFoundError('x').retryable).toBe(false);
  });

  it('honours an explicit code override and a cause', () => {
    const cause = new Error('root');
    const error = new MemoryValidationError('wrapped', { code: 'CUSTOM_CODE', cause });
    expect(error.code).toBe('CUSTOM_CODE');
    expect(error.cause).toBe(cause);
  });
});
