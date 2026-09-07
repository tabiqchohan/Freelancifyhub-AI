/**
 * Sprint 20 — Multi-Agent Coordination & Collaboration. Deterministic agent
 * selection (Sprint 20 §8).
 *
 * The selector vets a task's target agent BEFORE the plan is committed:
 *   - registered platform identity,
 *   - lifecycle readiness (READY/RUNNING),
 *   - a resolvable executor claiming the agent,
 *   - declared + enabled capabilities superset of required capabilities,
 *   - tool allowlist superset of required tools,
 *   - platform concurrency headroom.
 *
 * Selection never claims a slot (that belongs to the executor/platform gate at
 * invocation time, Sprint 19 §14) and never mutates the registry.
 */

import type { AgentId } from '../../ag-001-master-orchestrator/types/index.js';
import { AgentLifecycleState } from '../lifecycle.js';
import type { AgentDefinitionRegistry } from '../registry.js';
import type { AgentPlatformGateway } from '../gateway.js';
import type { ExecutorRegistry } from '../../ag-001-master-orchestrator/execution/index.js';
import { CoordinationAgentRejectedError } from './errors.js';
import type { TaskInvocation } from './types.js';

export type { AgentId };

/** Machine-readable rejection reasons for selection failures. */
export const AGENT_SELECTION_REASONS = {
  NOT_REGISTERED: 'NOT_REGISTERED',
  NOT_READY: 'NOT_READY',
  NO_EXECUTOR: 'NO_EXECUTOR',
  EXECUTOR_UNAVAILABLE: 'EXECUTOR_UNAVAILABLE',
  CAPABILITY_MISSING: 'CAPABILITY_MISSING',
  CAPABILITY_DISABLED: 'CAPABILITY_DISABLED',
  TOOL_NOT_ALLOWED: 'TOOL_NOT_ALLOWED',
  CONCURRENCY_LIMIT: 'CONCURRENCY_LIMIT',
} as const;

export type AgentSelectionReason =
  (typeof AGENT_SELECTION_REASONS)[keyof typeof AGENT_SELECTION_REASONS];

/** The outcome of vetting a task's target agent. */
export interface AgentSelection {
  readonly taskId: string;
  readonly agentId: AgentId;
  readonly selected: boolean;
  readonly reasonCode?: AgentSelectionReason;
  readonly message?: string;
}

/** Inputs the selector reads. All optional to keep tests minimal. */
export interface AgentSelectionContext {
  readonly registry: AgentDefinitionRegistry;
  readonly gateway: AgentPlatformGateway;
  readonly executorRegistry: ExecutorRegistry;
  readonly lifecycleReadiness?: readonly AgentLifecycleState[];
}

/** Deterministic pre-flight agent selection. */
export class AgentSelector {
  readonly name = 'coordination-agent-selector';

  private readonly context: AgentSelectionContext;

  constructor(context: AgentSelectionContext) {
    this.context = context;
  }

  /** Vets a single task against its declared target agent. */
  select(task: TaskInvocation): AgentSelection {
    const failure = this.reason(task);
    if (failure !== undefined) {
      return {
        taskId: task.taskId,
        agentId: task.agentId,
        selected: false,
        reasonCode: failure.reasonCode,
        message: failure.message,
      };
    }
    return { taskId: task.taskId, agentId: task.agentId, selected: true };
  }

  /** Vets all tasks; throws typed errors for rejected ones. */
  assertAll(task: readonly TaskInvocation[]): void {
    for (const invocation of task) {
      const selection = this.select(invocation);
      if (!selection.selected) {
        throw new CoordinationAgentRejectedError(
          `agent ${selection.agentId} rejected for task ${selection.taskId}: ${selection.message}`,
          {
            taskId: selection.taskId,
            agentId: selection.agentId,
            reasonCode: selection.reasonCode,
          },
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private reason(
    task: TaskInvocation,
  ): { reasonCode: AgentSelectionReason; message: string } | undefined {
    const managed = this.context.registry.getAgent(task.agentId);
    const executor = this.context.executorRegistry.resolve(task.agentId);

    if (managed !== undefined) {
      // Registered platform identity.
      const lifecycleState = this.context.registry.lifecycleStateOf(task.agentId);
      const readiness = this.context.lifecycleReadiness ?? [
        AgentLifecycleState.Ready,
        AgentLifecycleState.Running,
      ];
      if (lifecycleState === undefined || !readiness.includes(lifecycleState)) {
        return {
          reasonCode: AGENT_SELECTION_REASONS.NOT_READY,
          message: `agent ${task.agentId} is ${String(lifecycleState ?? 'unregistered')} (expected READY/RUNNING)`,
        };
      }
      // Executor that actually claims the agent.
      if (executor === undefined || !executor.canExecute(task.agentId)) {
        return {
          reasonCode: AGENT_SELECTION_REASONS.NO_EXECUTOR,
          message: `no executor can drive ${task.agentId}`,
        };
      }
      const status = executor.status();
      if (!status.available) {
        return {
          reasonCode: AGENT_SELECTION_REASONS.EXECUTOR_UNAVAILABLE,
          message: `executor for ${task.agentId} is unavailable`,
        };
      }
      // Declared + enabled capabilities superset.
      for (const capabilityId of task.requiredCapabilities) {
        const entry = managed.capabilities.find((c) => c.id === capabilityId);
        if (entry === undefined) {
          return {
            reasonCode: AGENT_SELECTION_REASONS.CAPABILITY_MISSING,
            message: `agent ${task.agentId} does not declare capability ${capabilityId}`,
          };
        }
        if (!entry.enabled) {
          return {
            reasonCode: AGENT_SELECTION_REASONS.CAPABILITY_DISABLED,
            message: `agent ${task.agentId} capability ${capabilityId} is disabled`,
          };
        }
      }
      // Tool allowlist superset.
      for (const toolName of task.requiredTools) {
        if (!managed.allowedTools.includes(toolName)) {
          return {
            reasonCode: AGENT_SELECTION_REASONS.TOOL_NOT_ALLOWED,
            message: `agent ${task.agentId} does not allow tool ${toolName}`,
          };
        }
      }
      // Platform concurrency headroom.
      const active = this.context.registry.lifecycleController.activeExecutionCount(task.agentId);
      if (active >= managed.limits.maxConcurrentExecutions) {
        return {
          reasonCode: AGENT_SELECTION_REASONS.CONCURRENCY_LIMIT,
          message: `agent ${task.agentId} is at its concurrency limit (${managed.limits.maxConcurrentExecutions})`,
        };
      }
      return undefined;
    }

    // Unmanaged runtime agent: executor availability only.
    if (executor === undefined || !executor.canExecute(task.agentId)) {
      return {
        reasonCode: AGENT_SELECTION_REASONS.NO_EXECUTOR,
        message: `no executor can drive ${task.agentId}`,
      };
    }
    if (!executor.status().available) {
      return {
        reasonCode: AGENT_SELECTION_REASONS.EXECUTOR_UNAVAILABLE,
        message: `executor for ${task.agentId} is unavailable`,
      };
    }
    return undefined;
  }
}
