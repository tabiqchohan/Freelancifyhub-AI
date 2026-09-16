/**
 * Sprint 26 — AI Operating System (AIOS) barrel export.
 */

export { AiosGateway } from './gateway.js';
export type { AiosGatewayOptions } from './gateway.js';
export {
  buildAiosConfig,
  parseAiosConfig,
  DEFAULT_AIOS_CONFIG,
  AiosConfigSchema,
} from './config.js';
export type { AiosConfig } from './config.js';
export { AiosService } from './service.js';
export type { AiosServiceDeps } from './service.js';
export { AiosPipeline } from './pipeline.js';
export type { AiosPipelineInput, AiosPipelineOptions } from './pipeline.js';
export { AiosEventLog } from './events.js';
export { AiosMetrics } from './metrics.js';
export { AiOperatingSystemPolicy, createDefaultPolicy } from './policy.js';
export type { AiosPolicy } from './policy.js';
export { AiosIdempotencyRegistry } from './idempotency.js';
export {
  AiosError,
  AiosErrorCode,
  isAiosError,
  toAiosError,
  AIOS_ERROR_HTTP_STATUS,
} from './errors.js';
export { composeAiosResponse } from './response.js';
export { assertNoSecrets, redactSecrets, isAdminRole } from './security.js';
export {
  createRequestContext,
  validateAiosActor,
  deriveExecutionTarget,
  routeInfo,
  AIOS_GATEWAY_NAME,
  AIOS_GATEWAY_VERSION,
} from './request-context.js';
export type { RequestContext, CreateRequestContextOptions } from './request-context.js';
export {
  createExecutionContext,
  createExactAiosPlan,
  AIOS_PLAN_STEPS,
  KNOB_DELAY_MS,
  KNOB_PROBE,
} from './execution-context.js';
export type {
  ExecutionContext,
  CreateExecutionContextOptions,
  AiosPlan,
  AiosCancellation,
} from './execution-context.js';
export { normalizeExecutionResult, toAiosStatus } from './execution-result.js';
export type { ExecutionCatcher } from './execution-result.js';
export {
  AiosStage,
  type AiosRequestStatus,
  type AiosActor,
  type AiosInput,
  type AiosRequestOptions,
  type AiosRequest,
  type AiosResponse,
  type AiosStatus,
  type AiosEvent,
  type AiosExecutionDetail,
  type AiosExecutionTarget,
  type AiosRouteInfo,
  type AiosGatewayContract,
} from './types.js';
