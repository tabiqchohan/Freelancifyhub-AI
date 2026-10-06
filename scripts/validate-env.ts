import { parseEnv } from '../src/config/env.js';
import { parseCompiledEnv } from '../src/app/env.js';

/**
 * Prompts15 Phase 6 — deployment gate.
 *
 * Previously this only ran the *base* schema (`parseEnv`), so a misconfigured
 * agent backend, LLM block or AIOS block would pass validation and then fail at
 * runtime startup with a much less actionable error. `parseCompiledEnv` is the
 * exact parser the composition root uses at boot, so validating with it means
 * `npm run validate:env` failing genuinely predicts a failed deploy.
 *
 * Secrets are never printed: only structural facts are reported.
 */

let failed = false;

try {
  const env = parseEnv();
  console.info(
    `Base environment configuration is valid (NODE_ENV=${env.NODE_ENV}, ` +
      `HOST=${env.HOST}, PORT=${env.PORT})`,
  );
} catch (error) {
  console.error(`Invalid environment configuration: ${String(error)}`);
  failed = true;
}

if (!failed) {
  try {
    const env = parseCompiledEnv();
    // Report which subsystems are durably configured without revealing values.
    console.info(
      `Compiled environment is valid (memory=${env.memory.MEMORY_STORAGE_BACKEND}, ` +
        `knowledge=${env.knowledge.KNOWLEDGE_STORAGE_BACKEND}, ` +
        `tools=${env.tools.TOOLS_STORAGE_BACKEND}, llmEnabled=${env.llm.LLM_ENABLED})`,
    );

    // The per-agent schemas accept any non-empty string and the composition
    // root branches on exact literals, rejecting everything else with
    // `UNSUPPORTED_STORAGE_BACKEND` at boot. Validate the allowlist here so a
    // typo surfaces at deploy time instead. Notably `postgres` is NOT valid.
    const knownBackends = new Set(['in-memory', 'durable']);
    const backends: ReadonlyArray<readonly [string, string]> = [
      ['MEMORY_STORAGE_BACKEND', env.memory.MEMORY_STORAGE_BACKEND],
      ['KNOWLEDGE_STORAGE_BACKEND', env.knowledge.KNOWLEDGE_STORAGE_BACKEND],
      ['TOOLS_STORAGE_BACKEND', env.tools.TOOLS_STORAGE_BACKEND],
    ];
    for (const [key, value] of backends) {
      if (!knownBackends.has(value)) {
        console.error(
          `Invalid environment configuration: ${key}="${value}" is not supported ` +
            `(expected one of: ${[...knownBackends].join(', ')}). ` +
            `The service would fail to start with UNSUPPORTED_STORAGE_BACKEND.`,
        );
        failed = true;
      }
      if (value === 'durable') {
        const url = env.memory.MEMORY_DATABASE_URL;
        if (url === undefined || url === '') {
          console.error(
            `Invalid environment configuration: ${key}=durable requires MEMORY_DATABASE_URL.`,
          );
          failed = true;
        }
      }
    }
    if (env.base.NODE_ENV === 'production') {
      const warnings: string[] = [];
      if (env.base.AIOS_SERVICE_TOKEN === '') {
        warnings.push(
          'AIOS_SERVICE_TOKEN is empty: every business endpoint will be DENIED (fail-closed).',
        );
      }
      if (env.base.AIOS_ADMIN_TOKEN === '') {
        warnings.push(
          'AIOS_ADMIN_TOKEN is empty: management endpoints will be DENIED (fail-closed).',
        );
      }
      for (const warning of warnings) {
        console.warn(`WARNING: ${warning}`);
      }
    }
  } catch (error) {
    console.error(`Invalid compiled environment configuration: ${String(error)}`);
    failed = true;
  }
}

if (failed) {
  process.exit(1);
}
