/**
 * Sprint 19 — Agent Capability Framework & Lifecycle. Built-in definitions.
 *
 * Default, server-controlled agent definitions shipped with the platform.
 * AG-101 mirrors the existing runtime agent and is activated by default;
 * AG-102 is a definition-only agent reserved for future wiring.
 */

import {
  AgentCategory,
  AgentStatus,
  DependencyType,
} from '../ag-001-master-orchestrator/types/index.js';
import type { AgentDefinition } from './types.js';
import { AgentExecutionMode } from './types.js';
import { capability } from './schemas.js';

/** Built-in platform definitions. */
export interface BuiltinAgentDefinitions {
  readonly projectDescriptionAgent: AgentDefinition;
  readonly budgetEstimatorAgent: AgentDefinition;
}

/** Version shared by builds that mirror the runtime agent manifests. */
export const BUILTIN_AGENT_VERSION = '1.0.0';

/** AG-101 — Project Description Agent (active, deterministic). */
export const DEFAULT_PROJECT_DESCRIPTION_AGENT: AgentDefinition = Object.freeze({
  agentId: 'AG-101',
  name: 'Project Description Agent',
  version: BUILTIN_AGENT_VERSION,
  description: 'Produces structured, deterministic project descriptions.',
  team: 'core',
  category: AgentCategory.Core,
  status: AgentStatus.Production,
  capabilities: Object.freeze([capability('project.read.describe')]),
  executionModes: Object.freeze([AgentExecutionMode.Deterministic]),
  allowedTools: Object.freeze([]),
  permissions: Object.freeze([]),
  limits: Object.freeze({
    maxExecutionTimeMs: 30_000,
    maxReasoningTurns: 0,
    maxToolCalls: 0,
    maxContextBytes: 32_768,
    maxOutputBytes: 32_768,
    maxConcurrentExecutions: 4,
  }),
  dependencies: Object.freeze([]),
  configuration: Object.freeze({}),
});

/** AG-102 — Budget Estimator (definition-only, reserved). */
export const DEFAULT_BUDGET_ESTIMATOR_AGENT: AgentDefinition = Object.freeze({
  agentId: 'AG-102',
  name: 'Budget Estimator',
  version: BUILTIN_AGENT_VERSION,
  description: 'Estimates project budgets from requirements (reserved).',
  team: 'core',
  category: AgentCategory.Marketplace,
  status: AgentStatus.Testing,
  capabilities: Object.freeze([capability('budget.estimate')]),
  executionModes: Object.freeze([AgentExecutionMode.Reasoning]),
  allowedTools: Object.freeze([]),
  permissions: Object.freeze(['knowledge.read']),
  limits: Object.freeze({
    maxExecutionTimeMs: 60_000,
    maxReasoningTurns: 4,
    maxToolCalls: 0,
    maxContextBytes: 32_768,
    maxOutputBytes: 32_768,
    maxConcurrentExecutions: 2,
  }),
  dependencies: Object.freeze([{ type: DependencyType.Agent, id: 'AG-101', required: false }]),
  configuration: Object.freeze({}),
});

/** All built-in definitions, in deterministic registration order. */
export function createDefaultAgentDefinitions(): BuiltinAgentDefinitions {
  return {
    projectDescriptionAgent: DEFAULT_PROJECT_DESCRIPTION_AGENT,
    budgetEstimatorAgent: DEFAULT_BUDGET_ESTIMATOR_AGENT,
  };
}
