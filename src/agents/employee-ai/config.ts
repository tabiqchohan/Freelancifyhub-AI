import { z } from 'zod';

/**
 * Prompts17 Phase 18 — AI Employee resource controls.
 *
 * Conservative, configurable bounds for a single AI Employee execution. Every
 * value is env-driven with a dead-safe production default, so limits can be
 * tuned without code changes and are never hard-coded inline.
 */

const booleanFromString = z
  .enum(['true', 'false'])
  .default('true')
  .transform((value) => value === 'true');

export const EmployeeConfigSchema = z.object({
  /** Feature flag: AI Employee subsystem. Fail-closed when disabled. */
  EMPLOYEE_ENABLED: booleanFromString,
  /**
   * Absolute or project-relative root for isolated employee workspaces. A
   * workspace is always `<root>/<projectId>/<taskId>` — an AI Employee can never
   * touch anything outside this tree (fail-closed path policy).
   */
  EMPLOYEE_WORKSPACE_ROOT: z.string().min(1).default('.employee-workspaces'),
  /** Hard deadline for one employee execution (planning + build + repair). */
  EMPLOYEE_MAX_EXECUTION_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(10 * 60_000),
  /** Maximum bounded repair attempts after a failed validation/build. */
  EMPLOYEE_MAX_REPAIR_ATTEMPTS: z.coerce.number().int().min(0).max(5).default(3),
  /** Maximum tool calls across one execution (filesystem + build + package). */
  EMPLOYEE_MAX_TOOL_CALLS: z.coerce.number().int().positive().default(100),
  /** Maximum total workspace size in bytes (100 MB). */
  EMPLOYEE_MAX_WORKSPACE_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(100 * 1024 * 1024),
  /** Maximum size of a single written file (10 MB). */
  EMPLOYEE_MAX_FILE_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(10 * 1024 * 1024),
  /** Maximum number of files in one workspace (256). */
  EMPLOYEE_MAX_FILE_COUNT: z.coerce.number().int().positive().default(256),
  /** Maximum packaged artifact size in bytes (50 MB). */
  EMPLOYEE_MAX_ARTIFACT_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(50 * 1024 * 1024),
  /** Per-command timeout for worker tool operations (15 s). */
  EMPLOYEE_TOOL_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  /** Bounded free-text client request accepted by the employee. */
  EMPLOYEE_MAX_REQUEST_TEXT: z.coerce.number().int().positive().default(8_000),
  /**
   * Prompts19 Phase 2 — durable task/artifact storage backend. `in-memory` is
   * for local development and tests only; `durable` persists task state and
   * artifact bytes to PostgreSQL so status/artifact survive a restart. In
   * production the backend defaults to `durable` and an explicit `in-memory`
   * is rejected (fail-closed), so state can never silently vanish.
   */
  EMPLOYEE_STORAGE_BACKEND: z.enum(['in-memory', 'durable']).optional(),
  /**
   * Prompts19 Phase 2 — connection string for durable task/artifact storage.
   * Falls back to the shared memory database URL when empty (never duplicated
   * into a second secret). Required when `EMPLOYEE_STORAGE_BACKEND=durable`.
   */
  EMPLOYEE_DATABASE_URL: z.string().default(''),
  /** Prompts19 Phase 4 — global cap on concurrently executing tasks. */
  EMPLOYEE_MAX_ACTIVE_TASKS: z.coerce.number().int().positive().default(4),
  /** Prompts19 Phase 4 — per-client cap on concurrently executing tasks. */
  EMPLOYEE_MAX_USER_ACTIVE_TASKS: z.coerce.number().int().positive().default(1),
  /**
   * Prompts19 Phase 4 — bounded backlog of accepted-but-not-yet-started tasks.
   * Requests beyond the concurrency caps are rejected with a resource-limit
   * error rather than queued without bound (backpressure).
   */
  EMPLOYEE_QUEUE_CAPACITY: z.coerce.number().int().min(0).default(16),
  /** Prompts19 Phase 2 — lifetime of a review artifact before the reaper removes it. */
  EMPLOYEE_ARTIFACT_TTL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(24 * 60 * 60_000),
  /** Prompts19 Phase 2 — interval between reaper sweeps for expired tasks/artifacts. */
  EMPLOYEE_REAP_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(10 * 60_000),
});

export type EmployeeConfig = z.infer<typeof EmployeeConfigSchema>;

export const DEFAULT_EMPLOYEE_CONFIG: EmployeeConfig = {
  EMPLOYEE_ENABLED: true,
  EMPLOYEE_WORKSPACE_ROOT: '.employee-workspaces',
  EMPLOYEE_MAX_EXECUTION_MS: 10 * 60_000,
  EMPLOYEE_MAX_REPAIR_ATTEMPTS: 3,
  EMPLOYEE_MAX_TOOL_CALLS: 100,
  EMPLOYEE_MAX_WORKSPACE_BYTES: 100 * 1024 * 1024,
  EMPLOYEE_MAX_FILE_BYTES: 10 * 1024 * 1024,
  EMPLOYEE_MAX_FILE_COUNT: 256,
  EMPLOYEE_MAX_ARTIFACT_BYTES: 50 * 1024 * 1024,
  EMPLOYEE_TOOL_TIMEOUT_MS: 15_000,
  EMPLOYEE_MAX_REQUEST_TEXT: 8_000,
  EMPLOYEE_STORAGE_BACKEND: undefined,
  EMPLOYEE_DATABASE_URL: '',
  EMPLOYEE_MAX_ACTIVE_TASKS: 4,
  EMPLOYEE_MAX_USER_ACTIVE_TASKS: 1,
  EMPLOYEE_QUEUE_CAPACITY: 16,
  EMPLOYEE_ARTIFACT_TTL_MS: 24 * 60 * 60_000,
  EMPLOYEE_REAP_INTERVAL_MS: 10 * 60_000,
};

/**
 * Prompts19 Phase 2 — resolve the effective storage backend. `durable` is the
 * only backend allowed in production; an explicit `in-memory` in production is
 * rejected so task state and artifacts can never silently reside only in RAM.
 */
export function resolveEmployeeStorageBackend(
  config: EmployeeConfig,
  nodeEnv: string = process.env.NODE_ENV ?? 'development',
): 'in-memory' | 'durable' {
  const explicit = config.EMPLOYEE_STORAGE_BACKEND;
  const resolved = explicit ?? (nodeEnv === 'production' ? 'durable' : 'in-memory');
  if (nodeEnv === 'production' && resolved === 'in-memory') {
    throw new Error(
      'EMPLOYEE_STORAGE_BACKEND=in-memory is not allowed in production; configure durable storage.',
    );
  }
  return resolved;
}

export function parseEmployeeConfig(raw: NodeJS.ProcessEnv = process.env): EmployeeConfig {
  const result = EmployeeConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid employee configuration:\n${issues}`);
  }
  return result.data;
}
