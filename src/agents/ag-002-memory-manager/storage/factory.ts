import type { MemoryConfig } from '../config/schema.js';
import { MemoryConfigurationError } from '../errors/index.js';
import { createDurableStorageAdapter } from './durable.js';
import { InMemoryStorageAdapter } from './in-memory.js';
import type { MemoryStorageAdapter } from './index.js';

/**
 * Sprint 6/10 — storage adapter factory (prompt §12). The default backend
 * remains the existing in-memory implementation. A durable backend identifier
 * is routed to the provider-neutral durable boundary and fail-closes with a
 * typed configuration error when no real backend is registered (rather than
 * silently falling back to non-durable storage).
 */
export function createStorageAdapter(
  config?: Pick<MemoryConfig, 'MEMORY_STORAGE_BACKEND'> &
    Partial<Pick<MemoryConfig, 'MEMORY_STORAGE_DURABLE_BACKEND'>>,
): MemoryStorageAdapter {
  const backend = config?.MEMORY_STORAGE_BACKEND ?? 'in-memory';
  switch (backend) {
    case 'in-memory':
      return new InMemoryStorageAdapter();
    case 'durable': {
      const durableBackend = config?.MEMORY_STORAGE_DURABLE_BACKEND;
      if (durableBackend === undefined || durableBackend.length === 0) {
        throw new MemoryConfigurationError(
          'MEMORY_STORAGE_BACKEND=durable requires MEMORY_STORAGE_DURABLE_BACKEND to name a ' +
            'registered durable backend. No durable backend is wired into AG-002 yet.',
          { details: { backend } },
        );
      }
      return createDurableStorageAdapter(durableBackend);
    }
    default:
      throw new MemoryConfigurationError(`Unsupported storage backend: ${backend}`, {
        details: { backend },
      });
  }
}
