/**
 * Sprint 18 — Agentic Tool-Calling. Loop limits configuration.
 *
 * All limits are validated and fail fast: an invalid value throws at
 * construction rather than degrading at runtime. Safe defaults keep the loop
 * bounded even when nothing is configured.
 */

import { z } from 'zod';

/** Default maximum reasoning turns per agentic operation. */
export const DEFAULT_AGENTIC_MAX_TURNS = 8;
/** Default maximum total tool calls per agentic operation. */
export const DEFAULT_AGENTIC_MAX_TOOL_CALLS = 6;
/** Default maximum tool calls the loop executes per single reasoning turn. */
export const DEFAULT_AGENTIC_MAX_TOOL_CALLS_PER_TURN = 1;
/** Default maximum bytes of a single captured tool result. */
export const DEFAULT_AGENTIC_MAX_TOOL_RESULT_BYTES = 8 * 1024;
/** Default maximum accumulated tool-result context bytes in the reasoning view. */
export const DEFAULT_AGENTIC_MAX_TOOL_CONTEXT_BYTES = 24 * 1024;
/** Default overall deadline for a single agentic operation. */
export const DEFAULT_AGENTIC_MAX_TOTAL_MS = 60_000;
/** Default maximum reasoning calls per operation (turns + slack). */
export const DEFAULT_AGENTIC_MAX_REASONING_CALLS = 12;
/** Default maximum aggregated output tokens per operation (cost/usage guard). */
export const DEFAULT_AGENTIC_MAX_TOKEN_BUDGET = 8_000;

/**
 * Validated runtime configuration for the agentic loop. Each field is bounded
 * and non-negative; zero disables the corresponding guard. Unknown env keys are
 * silently ignored (the surrounding process environment carries unrelated keys),
 * matching the codebase convention for env-parsed configs.
 */
export const AgenticConfigSchema = z.object({
  AGENTIC_MAX_TURNS: z.coerce.number().int().min(1).max(100).default(DEFAULT_AGENTIC_MAX_TURNS),
  AGENTIC_MAX_TOOL_CALLS: z.coerce
    .number()
    .int()
    .min(1)
    .max(200)
    .default(DEFAULT_AGENTIC_MAX_TOOL_CALLS),
  AGENTIC_MAX_TOOL_CALLS_PER_TURN: z.coerce
    .number()
    .int()
    .min(1)
    .max(25)
    .default(DEFAULT_AGENTIC_MAX_TOOL_CALLS_PER_TURN),
  AGENTIC_MAX_TOOL_RESULT_BYTES: z.coerce
    .number()
    .int()
    .min(1)
    .max(1024 * 1024)
    .default(DEFAULT_AGENTIC_MAX_TOOL_RESULT_BYTES),
  AGENTIC_MAX_TOOL_CONTEXT_BYTES: z.coerce
    .number()
    .int()
    .min(1)
    .max(1024 * 1024)
    .default(DEFAULT_AGENTIC_MAX_TOOL_CONTEXT_BYTES),
  AGENTIC_MAX_TOTAL_MS: z.coerce
    .number()
    .int()
    .min(1)
    .max(10 * 60 * 1000)
    .default(DEFAULT_AGENTIC_MAX_TOTAL_MS),
  AGENTIC_MAX_REASONING_CALLS: z.coerce
    .number()
    .int()
    .min(1)
    .max(500)
    .default(DEFAULT_AGENTIC_MAX_REASONING_CALLS),
  AGENTIC_MAX_TOKEN_BUDGET: z.coerce
    .number()
    .int()
    .min(1)
    .max(10_000_000)
    .default(DEFAULT_AGENTIC_MAX_TOKEN_BUDGET),
});

export type AgenticConfig = z.infer<typeof AgenticConfigSchema>;

/** Parses and validates agentic config from raw values (fail-fast). */
export function parseAgenticConfig(
  input: NodeJS.ProcessEnv | Record<string, string | undefined> = {},
): AgenticConfig {
  return AgenticConfigSchema.parse(input);
}

/** Defaults used when no environment provides agentic configuration. */
export function defaultAgenticConfig(): AgenticConfig {
  return AgenticConfigSchema.parse({});
}

/** Safe, loggable summary of the active limits (numbers only, never secrets). */
export function agenticLimitSummary(config: AgenticConfig): Readonly<Record<string, number>> {
  return {
    maxTurns: config.AGENTIC_MAX_TURNS,
    maxToolCalls: config.AGENTIC_MAX_TOOL_CALLS,
    maxToolCallsPerTurn: config.AGENTIC_MAX_TOOL_CALLS_PER_TURN,
    maxToolResultBytes: config.AGENTIC_MAX_TOOL_RESULT_BYTES,
    maxToolContextBytes: config.AGENTIC_MAX_TOOL_CONTEXT_BYTES,
    maxTotalMs: config.AGENTIC_MAX_TOTAL_MS,
    maxReasoningCalls: config.AGENTIC_MAX_REASONING_CALLS,
    maxTokenBudget: config.AGENTIC_MAX_TOKEN_BUDGET,
  };
}
