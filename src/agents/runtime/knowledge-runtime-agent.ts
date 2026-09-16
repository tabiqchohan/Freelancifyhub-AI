import type { Logger } from 'pino';

import type {
  AgentCapability,
  AgentConfiguration,
} from '../ag-001-master-orchestrator/interfaces/index.js';
import {
  AgentCategory,
  AgentStatus,
  DependencyType,
} from '../ag-001-master-orchestrator/types/index.js';
import { createOrchestratorLogger } from '../ag-001-master-orchestrator/utils/logger.js';
import type {
  RuntimeAgent,
  RuntimeAgentExecutionContext,
  RuntimeAgentExecutionResult,
} from './types.js';
import {
  cancellableDelay,
  clampDelay,
  isTruthy,
  parseInputNumber,
  summarizeInput,
} from './runtime-agent.js';

/** Identity of the deterministic knowledge manager runtime agent (AG-003). */
export const KNOWLEDGE_RUNTIME_AGENT_ID = 'AG-003';
export const KNOWLEDGE_RUNTIME_AGENT_NAME = 'Knowledge Manager';
export const KNOWLEDGE_RUNTIME_AGENT_VERSION = '1.0.0';

/** Capabilities exposed by the knowledge manager. */
export const KNOWLEDGE_RUNTIME_CAPABILITIES: readonly string[] = [
  'knowledge.search',
  'knowledge.answer',
];

/** Error code returned when the knowledge agent is asked to fail (test knob). */
export const KNOWLEDGE_AGENT_FAILURE_CODE = 'KNOWLEDGE_AGENT_FAILURE';

/** An entry the knowledge agent reports as sourced (bounded, never fabricated). */
export interface KnowledgeRuntimeCitation {
  readonly id: string;
  readonly title: string;
  readonly snippet: string;
}

/** Options for {@link createKnowledgeRuntimeAgent}. */
export interface KnowledgeRuntimeAgentOptions {
  readonly agentId?: string;
  readonly version?: string;
  readonly logger?: Logger;
}

/**
 * Deterministic, production-shaped agent filling the AG-003 (Knowledge
 * Manager) slot for the AI Operating System orchestrator tail.
 *
 * Mirrors the {@link createRuntimeAgent} contract: never touches external
 * services, reads `request.input` / `input`, and honours the same bounded
 * `runtime.delayMs` (0-5000) and `runtime.fail` knobs so E2E latency and
 * failure paths stay deterministic. Answers are bounded summaries of the
 * provided input; knowledge is never fabricated.
 */
export function createKnowledgeRuntimeAgent(
  options: KnowledgeRuntimeAgentOptions = {},
): RuntimeAgent {
  const agentId = options.agentId ?? KNOWLEDGE_RUNTIME_AGENT_ID;
  const version = options.version ?? KNOWLEDGE_RUNTIME_AGENT_VERSION;
  const logger = options.logger ?? createOrchestratorLogger('knowledge-runtime-agent');

  const capabilities: readonly AgentCapability[] = KNOWLEDGE_RUNTIME_CAPABILITIES.map((id) => ({
    id,
    name: id,
    enabled: true,
  }));

  const configuration: AgentConfiguration = {
    agentId,
    name: KNOWLEDGE_RUNTIME_AGENT_NAME,
    version,
    category: AgentCategory.Core,
    status: AgentStatus.InDevelopment,
    capabilities,
    dependencies: [{ type: DependencyType.Agent, id: 'AG-001', required: true }],
    limits: { maxTokens: 4000, maxAttempts: 3 },
  };

  async function execute(
    context: RuntimeAgentExecutionContext,
  ): Promise<RuntimeAgentExecutionResult> {
    const startedAt = Date.now();

    const raw =
      (context.inputs['request.input'] as string | undefined) ??
      (context.inputs['input'] as string | undefined) ??
      '';

    const delayMs = clampDelay(parseInputNumber(context.inputs['runtime.delayMs'], 0));
    if (delayMs > 0) {
      await cancellableDelay(delayMs, context.signal);
    }

    if (context.signal.requested) {
      return {
        success: false,
        error: {
          code: 'EXECUTION_CANCELLED',
          message: `Agent ${agentId} stopped after cancellation`,
          retryable: false,
        },
      };
    }

    if (isTruthy(context.inputs['runtime.fail'])) {
      logger.warn({ agentId, stepId: context.stepId }, 'knowledge agent failed via test knob');
      return {
        success: false,
        error: {
          code: KNOWLEDGE_AGENT_FAILURE_CODE,
          message: `Agent ${agentId} reported a deterministic failure`,
          retryable: false,
        },
      };
    }

    const hasQuery = String(raw).trim().length > 0;
    const parsed = summarizeInput(String(raw), 320);
    const citations: readonly KnowledgeRuntimeCitation[] = hasQuery
      ? [
          {
            id: `aios-knowledge-${agentId.toLowerCase()}`,
            title: 'Knowledge base index (AG-003)',
            snippet: parsed,
          },
        ]
      : [];

    const namespaces = [...new Set(context.memory.map((item) => item.namespace))];

    return {
      success: true,
      output: {
        answer: {
          text: parsed,
          confidence: citations.length > 0 ? 0.9 : 0,
          citations,
        },
        agent: {
          agentId,
          provider: 'runtime',
          version,
        },
        memory: {
          included: context.memory.length,
          namespaces,
        },
      },
      metadata: {
        provider: 'runtime',
        agentId,
        version,
        durationMs: Date.now() - startedAt,
        capabilityIds: [...KNOWLEDGE_RUNTIME_CAPABILITIES],
      },
    };
  }

  return {
    configuration,
    availability: { available: true },
    execute,
  };
}
