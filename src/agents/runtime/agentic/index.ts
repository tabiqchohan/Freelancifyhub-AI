/**
 * Sprint 18 — Agentic Tool-Calling & Reasoning Loop (public surface).
 *
 * The agentic loop coordinates reasoning → validated tool decisions through
 * the AG-004 {@link AgenticToolCoordinator} port. It is bounded, cancellable,
 * deadline-aware, observable, and fail-closed.
 */

export { AgenticLoopStateMachine, AGENTIC_TERMINAL_STATES } from './state.js';
export {
  AgenticEventLog,
  createAgenticEventLog,
  operationStartedEvent,
  reasoningStartedEvent,
  reasoningCompletedEvent,
  toolRequestedEvent,
  toolAuthorizedEvent,
  toolRejectedEvent,
  toolStartedEvent,
  toolCompletedEvent,
  toolFailedEvent,
  loopCompletedEvent,
  loopFailedEvent,
  loopCancelledEvent,
  loopTimedOutEvent,
  loopLimitReachedEvent,
  type AgenticEvent,
  type StoredAgenticEvent,
  type AgenticEventCategory,
  type AgenticEventType,
  type AgenticEventSeverity,
  type AgenticEventMetadata,
  type AgenticEventFilter,
  type AgenticEventQuery,
  type AgenticEventPage,
} from './events.js';
export { AgenticLoopMetrics } from './metrics.js';
export {
  AgenticConfigSchema,
  parseAgenticConfig,
  defaultAgenticConfig,
  agenticLimitSummary,
  type AgenticConfig,
} from './config.js';
export {
  AgenticLoopError,
  AgenticLoopLimitReachedError,
  AgenticLoopTimeoutError,
  AgenticLoopCancelledError,
  AgenticStateTransitionError,
  ToolDecisionInvalidError,
  AgenticToolNotFoundError,
  AgenticToolNotAuthorizedError,
  AgenticToolArgumentsInvalidError,
  AgenticToolExecutionFailedError,
  AgenticToolResultInvalidError,
  AgenticReasoningFailedError,
  classifyAgenticError,
  type AgenticErrorClass,
} from './errors.js';
export {
  AgenticToolManagerAdapter,
  type AgenticToolCoordinator,
  type AgenticToolInfo,
} from './tools.js';
export {
  buildToolInstructions,
  buildDecisionInstruction,
  toBoundedToolResult,
  formatBoundedToolResult,
  accumulateToolResults,
  isToolSuccess,
  TOOL_RESULT_BOUNDARY,
  type BoundedToolResult,
} from './prompt.js';
export {
  AgenticLoopService,
  createAgenticLoopService,
  type AgenticLoopServiceOptions,
} from './loop.js';
export {
  AgenticLoopState,
  AgenticLoopStatus,
  ToolCallStatus,
  type AgenticTurn,
  type ToolCall,
  type ToolCallRequest,
  type ToolCallArguments,
  type ToolCallResult,
  type ToolCallError,
  type ToolCallOutcome,
  type AgenticUsage,
  type AgenticToolRejection,
  type AgenticLoopRunInput,
  type AgenticLoopResult,
} from './contracts.js';
