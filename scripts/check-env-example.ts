import { readFileSync } from 'node:fs';

import { parseCompiledEnv } from '../src/app/env.js';

const raw = readFileSync('.env.example', 'utf8');
const parsed: Record<string, string> = {};
for (const line of raw.split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('=');
  if (i < 0) continue;
  let v = t.slice(i + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  parsed[t.slice(0, i).trim()] = v;
}

try {
  const env = parseCompiledEnv(parsed);
  console.log('ENV.EXAMPLE PARSES OK');
  console.log('  MEMORY_STORAGE_BACKEND =', env.memory.MEMORY_STORAGE_BACKEND);
  console.log('  KNOWLEDGE_STORAGE_BACKEND =', env.knowledge.KNOWLEDGE_STORAGE_BACKEND);
  console.log('  TOOLS_STORAGE_BACKEND =', env.tools.TOOLS_STORAGE_BACKEND);
  // Never print a secret value, not even an empty one from the example file.
  // A boolean "is it set" is enough to confirm the example parses.
  console.log('  AIOS_ADMIN_TOKEN set   =', env.base.AIOS_ADMIN_TOKEN !== undefined);
  console.log('  ALLOW_UNAUTHENTICATED  =', env.base.AIOS_ALLOW_UNAUTHENTICATED);
  console.log('  LOG_PRETTY             =', env.base.LOG_PRETTY);
  console.log('  HOST/PORT              =', env.base.HOST, env.base.PORT);
  console.log('  LLM_ENABLED            =', env.llm.LLM_ENABLED);
  console.log('  LLM_MAX_RESPONSE_BYTES =', env.llm.LLM_MAX_RESPONSE_BYTES);

  // Cross-check: every backend value the example documents must be one the
  // composition root understands (it branches on these exact literals).
  const knownBackends = new Set(['in-memory', 'durable']);
  const backends = {
    MEMORY_STORAGE_BACKEND: env.memory.MEMORY_STORAGE_BACKEND,
    KNOWLEDGE_STORAGE_BACKEND: env.knowledge.KNOWLEDGE_STORAGE_BACKEND,
    TOOLS_STORAGE_BACKEND: env.tools.TOOLS_STORAGE_BACKEND,
  };
  for (const [key, value] of Object.entries(backends)) {
    if (!knownBackends.has(value)) {
      console.log(`  DRIFT: ${key}="${value}" is not a value the composition root accepts`);
      process.exitCode = 1;
    }
  }
} catch (error) {
  console.log('ENV.EXAMPLE PARSE FAILED:');
  console.log((error as Error).message);
  process.exitCode = 1;
}
