/**
 * Sprint 20 — Multi-Agent Coordination & Collaboration. Shared constants.
 *
 * Bounds and defaults are server-controlled. They are never derived from user
 * or model input, keeping every coordination deterministic and bounded.
 */

/** Prefix for server-generated coordination ids. */
export const COORDINATION_ID_PREFIX = 'coord_';

/** Coordination id format `coord_...`. */
export const COORDINATION_ID_PATTERN = /^[a-z][a-z0-9_-]*$/;

/** Task id format (relaxed so AG-001 plans can use arbitrary ids). */
export const COORDINATION_TASK_ID_MAX_LENGTH = 200;

/** Worst-case total tasks in one coordination. */
export const COORDINATION_MAX_TASKS = 16;

/** Default concurrent running tasks within one coordination. */
export const COORDINATION_DEFAULT_MAX_CONCURRENT_TASKS = 4;

/** Default concurrent running tasks for a single agent. */
export const COORDINATION_DEFAULT_MAX_TASKS_PER_AGENT = 4;

/** Default whole-coordination deadline. */
export const COORDINATION_DEFAULT_GLOBAL_TIMEOUT_MS = 60_000;

/** Default per-task deadline. */
export const COORDINATION_DEFAULT_TASK_TIMEOUT_MS = 15_000;

/** Default coordination message size cap. */
export const COORDINATION_MAX_MESSAGE_BYTES = 32_768;

/** Default bounded retry values (Sprint 20 §16). */
export const COORDINATION_DEFAULT_RETRY = {
  maxRetries: 1,
  retryable: true,
  backoffMs: 50,
  backoffMultiplier: 2,
  maxBackoffMs: 2_000,
} as const;

/** Hard cap on retries (fail closed beyond this). */
export const COORDINATION_MAX_RETRIES = 5;

/** Default resolved coordination limits. */
export const DEFAULT_COORDINATION_LIMITS = {
  maxTasks: COORDINATION_MAX_TASKS,
  maxConcurrentTasks: COORDINATION_DEFAULT_MAX_CONCURRENT_TASKS,
  maxTasksPerAgent: COORDINATION_DEFAULT_MAX_TASKS_PER_AGENT,
  globalTimeoutMs: COORDINATION_DEFAULT_GLOBAL_TIMEOUT_MS,
  defaultTaskTimeoutMs: COORDINATION_DEFAULT_TASK_TIMEOUT_MS,
  maxMessageBytes: COORDINATION_MAX_MESSAGE_BYTES,
} as const;
