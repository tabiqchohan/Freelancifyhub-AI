import type { MemoryConfig } from '../config/schema.js';
import { MemoryConfigurationError } from '../errors/index.js';
import {
  createDurableStorageAdapter,
  listDurableBackends,
  registerDurableBackend,
} from './durable.js';
import { InMemoryStorageAdapter } from './in-memory.js';
import type { MemoryStorageAdapter } from './index.js';
import { buildPostgresBackend } from './postgres-backend.js';

/** Default durable backend identifier resolved when none is configured. */
export const DEFAULT_DURABLE_BACKEND = 'postgres';

// Register the real Postgres backend once. The factory is lazy — no connection
// is opened and no URL is read until createDurableStorageAdapter() runs.
if (!listDurableBackends().includes(DEFAULT_DURABLE_BACKEND)) {
  registerDurableBackend(DEFAULT_DURABLE_BACKEND, () => buildPostgresBackend());
}

/**
 * Sprint 6/10/13 — storage adapter factory (prompt §12). The default backend
 * remains the existing in-memory implementation. A durable backend identifier
 * is routed to the provider-neutral durable boundary: it defaults to the real
 * PostgreSQL backend ('postgres') when no durable backend is named, and
 * fail-closes with a typed configuration error when that backend cannot be
 * constructed (e.g. missing MEMORY_DATABASE_URL) or is unknown — it never
 * silently falls back to non-durable storage.
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
      const durableBackend = config?.MEMORY_STORAGE_DURABLE_BACKEND?.length
        ? config.MEMORY_STORAGE_DURABLE_BACKEND
        : DEFAULT_DURABLE_BACKEND;
      return createDurableStorageAdapter(durableBackend);
    }
    default:
      throw new MemoryConfigurationError(`Unsupported storage backend: ${backend}`, {
        details: { backend },
      });
  }
}
