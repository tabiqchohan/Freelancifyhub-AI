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

/** Error code returned when a runtime agent is asked to fail (test knob). */
export const RUNTIME_AGENT_FAILURE_CODE = 'RUNTIME_AGENT_FAILURE';

/** Default identity of the first production runtime agent (AG-101 slot). */
export const DEFAULT_RUNTIME_AGENT_ID = 'AG-101';
export const DEFAULT_RUNTIME_AGENT_NAME = 'Project Description Agent';
export const DEFAULT_RUNTIME_AGENT_VERSION = '1.0.0';

export const DEFAULT_RUNTIME_CAPABILITIES: readonly string[] = [
  'project.create',
  'project.edit',
  'project.delete',
  'project.view',
];

/** Options for {@link createRuntimeAgent}. */
export interface RuntimeAgentOptions {
  readonly agentId?: string;
  readonly name?: string;
  readonly version?: string;
  readonly capabilityIds?: readonly string[];
  readonly logger?: Logger;
}

/** Sanitises request text into a deterministic, bounded summary. */
export function summarizeInput(text: string, maxLength = 160): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) {
    return 'Project description not provided.';
  }
  return collapsed.length <= maxLength ? collapsed : `${collapsed.slice(0, maxLength)}...`;
}

/**
 * Deterministic, production-shaped agent filling the AG-101 (Project
 * Description Agent) slot (Phase 4).
 *
 * Never touches external services; it is the executable target the
 * orchestrator routes project requests to. Inputs are read from
 * `request.input` / `input`. Optional deterministic knobs are accepted via
 * `runtime.delayMs` (0-5000) and `runtime.fail` so E2E paths can exercise
 * latency and failure without randomness.
 */
export function createRuntimeAgent(options: RuntimeAgentOptions = {}): RuntimeAgent {
  const agentId = options.agentId ?? DEFAULT_RUNTIME_AGENT_ID;
  const name = options.name ?? DEFAULT_RUNTIME_AGENT_NAME;
  const version = options.version ?? DEFAULT_RUNTIME_AGENT_VERSION;
  const capabilityIds = options.capabilityIds ?? DEFAULT_RUNTIME_CAPABILITIES;
  const logger = options.logger ?? createOrchestratorLogger('runtime-agent');

  const capabilities: readonly AgentCapability[] = capabilityIds.map((id) => ({
    id,
    name: id,
    enabled: true,
  }));

  const configuration: AgentConfiguration = {
    agentId,
    name,
    version,
    category: AgentCategory.Client,
    status: AgentStatus.InDevelopment,
    capabilities,
    dependencies: [{ type: DependencyType.Agent, id: 'AG-001', required: true }],
    limits: { maxTokens: 6000, maxAttempts: 3 },
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
      logger.warn({ agentId, stepId: context.stepId }, 'runtime agent failed via test knob');
      return {
        success: false,
        error: {
          code: RUNTIME_AGENT_FAILURE_CODE,
          message: `Agent ${agentId} reported a deterministic failure`,
          retryable: false,
        },
      };
    }

    const summary = summarizeInput(String(raw));
    const namespaces = [...new Set(context.memory.map((item) => item.namespace))];

    return {
      success: true,
      output: {
        project: {
          name: agentId,
          kind: 'description',
          summary,
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
      },
    };
  }

  return {
    configuration,
    availability: { available: true },
    execute,
  };
}

/** Parses a possibly-string numeric knob into an integer or fallback. */
function parseInputNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function clampDelay(value: number): number {
  return Math.min(Math.max(Math.trunc(value), 0), 5000);
}

function isTruthy(value: unknown): boolean {
  return value === true || value === 'true' || value === 1 || value === '1' || value === 'yes';
}

/** Delays without blocking cancellation; aborts early when cancelled. */
function cancellableDelay(
  ms: number,
  signal: RuntimeAgentExecutionContext['signal'],
): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    void signal.waitForCancellation().then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}
