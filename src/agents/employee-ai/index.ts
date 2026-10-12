/**
 * Prompts17 Phase 18 — AI Employee (AG-701 Website Developer) subsystem.
 *
 * Barrel for the first commercial AI employee. Everything an external caller
 * needs (service, config, tools, status DTOs) is re-exported here.
 */
export { EmployeeConfigSchema, DEFAULT_EMPLOYEE_CONFIG, parseEmployeeConfig } from './config.js';
export type { EmployeeConfig } from './config.js';
export { EmployeeError, EmployeeErrorCode } from './errors.js';
export type { EmployeeErrorCodeValue } from './errors.js';
export { classifyScope, assertSupportedScope } from './scope.js';
export type { ScopeDecision } from './scope.js';
export { extractRequirements, buildExecutionPlan } from './requirements.js';
export { WorkspaceManager } from './workspace.js';
export { generateStaticSite } from './generator.js';
export {
  buildStaticSite,
  validateBuiltSite,
  validateHtmlHygiene,
  extractInternalLinks,
  defaultValidationRequirements,
} from './build.js';
export { createZip, sha256Hex, crc32 } from './zip.js';
export {
  createEmployeeToolSpecifications,
  EMPLOYEE_WRITE_TOOL,
  EMPLOYEE_BUILD_TOOL,
  EMPLOYEE_VALIDATE_TOOL,
  EMPLOYEE_PACKAGE_TOOL,
} from './tools.js';
export type { EmployeeToolsContext } from './tools.js';
export { pinoEmployeeEventSink, EmployeeEventType } from './events.js';
export type { EmployeeEvent, EmployeeEventSink } from './events.js';
export { createEmployeeMetrics } from './metrics.js';
export type { EmployeeMetrics } from './metrics.js';
export { EmployeeExecutor, TaskToolBudget } from './execution.js';
export type {
  EmployeeToolGateway,
  EmployeeExecutorOptions,
  EmployeeExecutionResult,
} from './execution.js';
export { EmployeeService } from './service.js';
export type { EmployeeServiceOptions } from './service.js';
export { resolveEmployeeStorageBackend } from './config.js';
export { InMemoryEmployeeTaskRepository } from './storage/in-memory.js';
export { PostgresEmployeeTaskRepository } from './storage/postgres.js';
export type { PostgresEmployeeTaskRepositoryOptions } from './storage/postgres.js';
export type { EmployeeTaskRepository } from './storage/interface.js';
export type { EmployeeTaskRecord, EmployeeArtifactBytes } from './storage/types.js';
export {
  migrateEmployeeSchema,
  EMPLOYEE_SCHEMA_MIGRATIONS,
  EMPLOYEE_SCHEMA_VERSION,
} from './storage/schema.js';
export { EmployeeReaper } from './reaper.js';
export type { EmployeeReaperOptions } from './reaper.js';
export { EmployeePhase, EmployeeScopeTier, TERMINAL_PHASES, isTerminalPhase } from './types.js';
export type {
  EmployeePhaseValue,
  EmployeeScopeTierValue,
  EmployeeResult,
  EmployeeRunRequest,
  EmployeeRunResponse,
  EmployeeStatusResponse,
  EmployeeArtifactResponse,
  SiteSpec,
  ExecutionPlan,
  ValidationReport,
  ArtifactInfo,
  WebsiteTaskInput,
} from './types.js';
