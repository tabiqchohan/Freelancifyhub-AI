import type { MemoryConfig } from '../config/schema.js';
import { MemoryConfigurationError } from '../errors/index.js';
import { InMemoryStorageAdapter } from './in-memory.js';
import type { MemoryStorageAdapter } from './index.js';

/**
 * Sprint 6 — storage adapter factory (prompt §12). The default backend remains
 * the existing in-memory implementation. Unknown backends fail closed with a
 * typed configuration error rather than silently falling back.
 */
export function createStorageAdapter(
  config?: Pick<MemoryConfig, 'MEMORY_STORAGE_BACKEND'>,
): MemoryStorageAdapter {
  const backend = config?.MEMORY_STORAGE_BACKEND ?? 'in-memory';
  switch (backend) {
    case 'in-memory':
      return new InMemoryStorageAdapter();
    default:
      throw new MemoryConfigurationError(`Unsupported storage backend: ${backend}`, {
        details: { backend },
      });
  }
}
