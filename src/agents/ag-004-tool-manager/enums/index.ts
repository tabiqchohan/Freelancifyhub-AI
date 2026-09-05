/** Canonical enums for the AG-004 Tool Manager subsystem (Sprint 16). */

/** Tool categories — extensible set of coarse tool domains. */
export enum ToolCategory {
  Computation = 'COMPUTATION',
  Search = 'SEARCH',
  Http = 'HTTP',
  Database = 'DATABASE',
  FileSystem = 'FILESYSTEM',
  Communication = 'COMMUNICATION',
  Internal = 'INTERNAL',
  External = 'EXTERNAL',
  Other = 'OTHER',
}

/** Permission kinds for tool operations (deny-by-default). */
export enum ToolPermission {
  Read = 'READ',
  Execute = 'EXECUTE',
  Register = 'REGISTER',
  Update = 'UPDATE',
  Enable = 'ENABLE',
  Disable = 'DISABLE',
  Delete = 'DELETE',
  Admin = 'ADMIN',
}

/** Actor groups that may interact with tools. */
export enum ToolActorGroup {
  Orchestrator = 'ORCHESTRATOR',
  MemoryManager = 'MEMORY_MANAGER',
  KnowledgeManager = 'KNOWLEDGE_MANAGER',
  ToolManager = 'TOOL_MANAGER',
  Client = 'CLIENT',
  Freelancer = 'FREELANCER',
  Marketplace = 'MARKETPLACE',
  Marketing = 'MARKETING',
  Admin = 'ADMIN',
}

/** Security classification of a tool. */
export enum ToolSecurityLevel {
  Internal = 'INTERNAL',
  Confidential = 'CONFIDENTIAL',
}

/** Enabled/disabled runtime state of a tool. */
export enum ToolStatus {
  Enabled = 'ENABLED',
  Disabled = 'DISABLED',
}

/** Typed outcome of a tool execution. */
export enum ToolResultStatus {
  Success = 'SUCCESS',
  ValidationFailed = 'VALIDATION_FAILED',
  AuthorizationFailed = 'AUTHORIZATION_FAILED',
  Timeout = 'TIMEOUT',
  Cancelled = 'CANCELLED',
  ExecutionFailed = 'EXECUTION_FAILED',
  Disabled = 'DISABLED',
  NotFound = 'NOT_FOUND',
}

/** Coarse error classification used by retry policy. */
export enum ToolErrorClass {
  Retryable = 'RETRYABLE',
  NonRetryable = 'NON_RETRYABLE',
  Authorization = 'AUTHORIZATION',
  Validation = 'VALIDATION',
  Timeout = 'TIMEOUT',
  Cancellation = 'CANCELLATION',
  Internal = 'INTERNAL',
}

/** Audit event types emitted by the tool subsystem. */
export enum ToolEventType {
  Registered = 'tool.registered',
  Updated = 'tool.updated',
  Enabled = 'tool.enabled',
  Disabled = 'tool.disabled',
  Removed = 'tool.removed',
  ExecutionStarted = 'tool.execution.started',
  ExecutionSucceeded = 'tool.execution.succeeded',
  ExecutionFailed = 'tool.execution.failed',
  ExecutionTimeout = 'tool.execution.timeout',
  ExecutionCancelled = 'tool.execution.cancelled',
  AuthorizationDenied = 'tool.authorization.denied',
}
