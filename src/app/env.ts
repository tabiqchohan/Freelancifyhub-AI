import type { Env } from '../config/index.js';
import { parseEnv } from '../config/index.js';
import type { MemoryConfig } from '../agents/ag-002-memory-manager/config/schema.js';
import { parseMemoryConfig } from '../agents/ag-002-memory-manager/config/index.js';

/**
 * Environment surface consumed by the production composition root. Combines the
 * base {@link Env} (host/port/logging) with the AG-002 memory config derived
 * from the same process environment. Secrets (e.g. MEMORY_DATABASE_URL) are
 * never logged or surfaced; they are read once here and consumed downstream.
 */
export interface Environment {
  readonly base: Env;
  readonly memory: MemoryConfig;
}

/** Parses the runtime environment; throwable (fail-closed) on invalid env. */
export function parseCompiledEnv(raw: NodeJS.ProcessEnv = process.env): Environment {
  const base = parseEnv(raw);
  const memory = parseMemoryConfig(raw);
  return { base, memory };
}
