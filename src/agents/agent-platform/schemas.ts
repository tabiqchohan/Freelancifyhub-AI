/**
 * Sprint 19 — Agent Capability Framework & Lifecycle. Zod validation.
 *
 * All agent definitions are validated on registration. Definitions are
 * server-controlled: user and model input can never reach these schemas.
 */

import { z } from 'zod';

import {
  AgentCategory,
  AgentStatus,
  DependencyType,
} from '../ag-001-master-orchestrator/types/index.js';
import {
  AGENT_CAPABILITY_PATTERN,
  AGENT_ID_PATTERN,
  AGENT_PERMISSION_PATTERN,
  AGENT_TOOL_NAME_PATTERN,
  AGENT_VERSION_PATTERN,
  DEFAULT_AGENT_LIMITS,
} from './constants.js';
import { AgentExecutionMode, type AgentDefinition } from './types.js';
import { AgentDefinitionInvalidError } from './errors.js';

/** Agent id must follow the project `AG-NNN` convention. */
export const agentIdSchema = z
  .string()
  .regex(AGENT_ID_PATTERN, 'agentId must match the AG-NNN convention');

/** Semantic version (major.minor.patch). */
export const agentVersionSchema = z
  .string()
  .regex(AGENT_VERSION_PATTERN, 'version must be semantic (x.y.z)');

/** Capability id must be `domain.action` (e.g. `project.create`). */
export const agentCapabilitySchema = z.object({
  id: z.string().regex(AGENT_CAPABILITY_PATTERN, 'capability id must be domain.action'),
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  enabled: z.boolean(),
});

/** Execution mode must be one of the supported values. */
export const agentExecutionModeSchema = z.enum([
  AgentExecutionMode.Deterministic,
  AgentExecutionMode.Reasoning,
  AgentExecutionMode.Agentic,
]);

/** Permission id must be `domain.action` (e.g. `memory.read`). */
export const agentPermissionSchema = z
  .string()
  .regex(AGENT_PERMISSION_PATTERN, 'permission id must be domain.action');

/** Tool name must match AG-004 tool name rules. */
export const agentToolNameSchema = z
  .string()
  .regex(AGENT_TOOL_NAME_PATTERN, 'tool name is invalid');

/** Dependency declarations (AG-001 shape). */
export const agentDependencySchema = z.object({
  type: z.enum(Object.values(DependencyType) as [string, ...string[]]),
  id: z.string().min(1).max(200),
  required: z.boolean(),
});

/** Structural execution limits (defaults applied at parse time). */
export const agentLimitsInputSchema = z.object({
  maxExecutionTimeMs: z.number().int().positive().optional(),
  maxReasoningTurns: z.number().int().nonnegative().optional(),
  maxToolCalls: z.number().int().nonnegative().optional(),
  maxContextBytes: z.number().int().positive().optional(),
  maxOutputBytes: z.number().int().positive().optional(),
  maxConcurrentExecutions: z.number().int().positive().optional(),
  maxTokenBudget: z.number().int().positive().optional(),
});

/** Fully-defaulted limits used for every parsed definition. */
export const agentLimitsSchema = z.object({
  maxExecutionTimeMs: z.number(),
  maxReasoningTurns: z.number(),
  maxToolCalls: z.number(),
  maxContextBytes: z.number(),
  maxOutputBytes: z.number(),
  maxConcurrentExecutions: z.number(),
  maxTokenBudget: z.number().optional(),
});

/**
 * The full Agent Definition schema. Strict: unknown fields are rejected so a
 * definition can never silently carry unvalidated configuration.
 */
export const agentDefinitionSchema = z
  .object({
    agentId: agentIdSchema,
    name: z.string().min(1).max(200),
    version: agentVersionSchema,
    description: z.string().max(2000).default(''),
    team: z.string().min(1).max(100),
    category: z.enum(Object.values(AgentCategory) as [string, ...string[]]),
    status: z.enum(Object.values(AgentStatus) as [string, ...string[]]),
    capabilities: z.array(agentCapabilitySchema).default([]),
    executionModes: z.array(agentExecutionModeSchema).min(1, 'at least one execution mode'),
    allowedTools: z.array(agentToolNameSchema).default([]),
    permissions: z.array(agentPermissionSchema).default([]),
    limits: agentLimitsInputSchema.optional(),
    dependencies: z.array(agentDependencySchema).default([]),
    configuration: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

/** Validates and normalizes an agent definition into a typed contract. */
export function parseAgentDefinition(input: unknown): AgentDefinition {
  const parsed = agentDefinitionSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));
    throw new AgentDefinitionInvalidError('Agent definition failed validation', {
      issues,
    });
  }
  const data = parsed.data;
  const parsedLimits = agentLimitsSchema.safeParse(data.limits ?? {});
  const limits = parsedLimits.success
    ? parsedLimits.data
    : { ...DEFAULT_AGENT_LIMITS, ...(data.limits ?? {}) };
  return { ...data, limits } as unknown as AgentDefinition;
}

/** Safe boolean validation used by registry discovery helpers. */
export function isValidAgentDefinition(input: unknown): boolean {
  return agentDefinitionSchema.safeParse(input).success;
}

/** Convenience factory for a single capability entry. */
export function capability(
  id: string,
  enabled = true,
): {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
} {
  return { id, name: id, enabled };
}
