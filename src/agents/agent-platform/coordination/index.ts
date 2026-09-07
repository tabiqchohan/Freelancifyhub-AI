/**
 * Sprint 20 — Multi-Agent Coordination & Collaboration. Public surface.
 *
 * The coordination layer is generic, reusable coordination infrastructure
 * sitting strictly ABOVE the Sprint 19 Agent Platform. Business-specific
 * agents (Client AI, Freelancer AI, Marketplace AI, Marketing AI, Admin AI)
 * are NOT implemented here — this module only provides the reusable plumbing
 * AG-001 composes against.
 */

export * from './types.js';
export * from './constants.js';
export * from './errors.js';
export * from './ids.js';

export { CoordinationPlanner, resolveLimits } from './task-decomposition.js';
export type { CoordinationPlannerOptions } from './task-decomposition.js';
export { AgentSelector } from './agent-selection.js';
export type {
  AgentSelection,
  AgentSelectionContext,
  AgentSelectionReason,
} from './agent-selection.js';
export { AGENT_SELECTION_REASONS } from './agent-selection.js';
export { TaskDependencyGraph } from './dependency-graph.js';
export type { TaskGraph } from './dependency-graph.js';
export { CoordinationStateStore, createCoordinationState } from './coordination-state.js';
export type { CoordinationStateSnapshot } from './coordination-state.js';
export {
  canTransition,
  applyTransition,
  markTaskReady,
  markTaskRunning,
  markTaskCompleted,
  markTaskFailed,
  markTaskSkipped,
  markTaskCancelled,
  markTaskTimedOut,
} from './task-state.js';
export type { StateTransition } from './task-state.js';
export { CoordinationMessageBus } from './messages.js';
export type { StoredCoordinationMessage } from './messages.js';
export { detectConflicts, resolveConflicts, throwIfConflictsFail } from './conflict.js';
export type { ConflictDetectionInput, ConflictResolution } from './conflict.js';
export { aggregateResults, deepEqual } from './aggregation.js';
export { decideRetry, computeBackoff, waitForBackoff, isRetryableError } from './retry.js';
export type { RetryDecision } from './retry.js';
export { RuntimeAgentInvocationAdapter } from './invocation.js';
export type { InvocationOutcome } from './invocation.js';
export { CoordinationCoordinator } from './coordinator.js';
export type {
  CoordinationCoordinatorOptions,
  CoordinationCoordinatorStatus,
} from './coordinator.js';
export { CoordinationEventLog } from './events.js';
export type {
  CoordinationEvent,
  StoredCoordinationEvent,
  CoordinationEventFilter,
  CoordinationEventMetadata,
  CoordinationEventType,
  CoordinationEventCategory,
  CoordinationEventSeverity,
  CoordinationEventInput,
} from './events.js';
export {
  coordinationCreatedEvent,
  coordinationStartedEvent,
  taskCreatedEvent,
  taskReadyEvent,
  taskStartedEvent,
  taskCompletedEvent,
  taskFailedEvent,
  taskCancelledEvent,
  taskTimedOutEvent,
  taskRetryingEvent,
  agentSelectedEvent,
  agentRejectedEvent,
  resultReceivedEvent,
  conflictDetectedEvent,
  coordinationCancelledEvent,
  coordinationCompletedEvent,
  coordinationFailedEvent,
} from './events.js';
export { CoordinationMetrics } from './metrics.js';
export type {
  CoordinationCounters,
  CoordinationGauges,
  CoordinationMetricsSnapshot,
} from './metrics.js';
export {
  coordinationRequestSchema,
  coordinationTaskInputSchema,
  coordinationMessageSchema,
  coordinationTaskResultSchema,
  coordinationLimitsSchema,
  coordinationModeSchema,
  coordinationTaskStatusSchema,
  parseCoordinationRequest,
  parseCoordinationTaskInput,
  parseCoordinationMessage,
  parseTaskResult,
  assertMessageSize,
} from './schemas.js';
