/**
 * Sprint 19 — Agent Capability Framework & Lifecycle. Shared constants.
 *
 * Agent identities, capability/permission/tool identifiers, and lifecycle
 * defaults are stable, server-controlled values. They are never derived from
 * user or model input.
 */

/** Stable agent id format in the project's `AG-NNN` convention. */
export const AGENT_ID_PATTERN = /^[A-Z]{2}-\d{3,}$/;

/** Semantic version format for agent definitions. */
export const AGENT_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

/** Capability id format (`domain.action`, e.g. `project.create`). */
export const AGENT_CAPABILITY_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z0-9]+)+$/;

/** Permission id format (`domain.action`, e.g. `memory.read`). */
export const AGENT_PERMISSION_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z0-9]+)+$/;

/** Tool name format (matches AG-004 tool identifiers). */
export const AGENT_TOOL_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

/** Platform-level capability ids (Sprint 19). Domain id values often collide
 * with routing catalog capability ids (e.g. `project.create`); execution
 * capabilities are the only platform-owned ones. */
export const PLATFORM_EXECUTION_CAPABILITIES = {
  REASONING: 'agent.reasoning',
  AGENTIC: 'agent.agentic',
} as const;

/** Declarative agent permissions (Sprint 19 §9). NOT a replacement for AG-004
 * authorization or request-actor authorization. */
export const AGENT_PERMISSIONS = {
  MEMORY_READ: 'memory.read',
  MEMORY_WRITE: 'memory.write',
  KNOWLEDGE_READ: 'knowledge.read',
  KNOWLEDGE_WRITE: 'knowledge.write',
  TOOL_EXECUTE: 'tool.execute',
  EXTERNAL_NETWORK: 'external.network',
  USER_DATA_READ: 'user.data.read',
  USER_DATA_WRITE: 'user.data.write',
  ADMIN_OPERATIONS: 'admin.operations',
} as const;

export type AgentPermissionId = (typeof AGENT_PERMISSIONS)[keyof typeof AGENT_PERMISSIONS];

/** Default structural limits applied when a definition omits values. */
export const DEFAULT_AGENT_LIMITS = {
  maxExecutionTimeMs: 30_000,
  maxReasoningTurns: 8,
  maxToolCalls: 6,
  maxContextBytes: 65_536,
  maxOutputBytes: 65_536,
  maxConcurrentExecutions: 4,
} as const;
