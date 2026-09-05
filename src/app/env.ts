import type { Env } from '../config/index.js';
import { parseEnv } from '../config/index.js';
import type { MemoryConfig } from '../agents/ag-002-memory-manager/config/schema.js';
import { parseMemoryConfig } from '../agents/ag-002-memory-manager/config/index.js';
import type { KnowledgeConfig } from '../agents/ag-003-knowledge-manager/config/schema.js';
import { parseKnowledgeConfig } from '../agents/ag-003-knowledge-manager/config/index.js';
import type { ToolConfig } from '../agents/ag-004-tool-manager/config/schema.js';
import { parseToolConfig } from '../agents/ag-004-tool-manager/config/index.js';
import type { LLMConfig } from '../llm/config/schema.js';
import { parseLlmConfig } from '../llm/config/index.js';

/**
 * Environment surface consumed by the production composition root. Combines the
 * base {@link Env} (host/port/logging) with the AG-002 memory config, the
 * AG-003 knowledge config, the AG-004 tool config, and the LLM config derived
 * from the same process environment. Secrets are never logged or surfaced;
 * they are read once here and consumed downstream. The tool database URL is
 * reused from the shared config when present (never duplicated).
 */
export interface Environment {
  readonly base: Env;
  readonly memory: MemoryConfig;
  readonly knowledge: KnowledgeConfig;
  readonly tools: ToolConfig;
  readonly llm: LLMConfig;
}

/** Parses the runtime environment; throwable (fail-closed) on invalid env. */
export function parseCompiledEnv(raw: NodeJS.ProcessEnv = process.env): Environment {
  const base = parseEnv(raw);
  const memory = parseMemoryConfig(raw);
  const knowledge = parseKnowledgeConfig(raw);
  const tools = parseToolConfig(raw);
  const llm = parseLlmConfig(raw);
  return { base, memory, knowledge, tools, llm };
}
