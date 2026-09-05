import { ToolResultStatus, ToolEventType, ToolPermission } from '../enums/index.js';
import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolJsonValue,
  ToolResult,
} from '../types/index.js';
import type { ToolRegistry } from '../registry/index.js';
import type { ToolAuthorizationService } from '../security/index.js';
import type { ToolMetrics } from '../metrics/index.js';
import type { ToolEventLog } from '../events/log.js';
import type { ToolEvent } from '../events/index.js';
import { ToolInputValidator, ToolOutputValidator } from '../validators/index.js';
import { ToolAccessDeniedError } from '../errors/index.js';
import {
  runWithTimeoutAndCancellation,
  classifyToolError,
  isRetryableClass,
  retryDelayMs,
  cancellableDelay,
} from '../policies/index.js';
import { sanitizeToolOutput } from '../utils/sanitize.js';
import { createExecutionId, nowIso, createTraceId } from '../utils/ids.js';
import type { ToolConfig } from '../config/schema.js';

/**
 * AG-004 production Tool Executor.
 *
 * Execution pipeline:
 *   1. resolve registered tool
 *   2. verify enabled state
 *   3. verify authorization
 *   4. validate input
 *   5. enforce execution policy
 *   6. enforce timeout
 *   7. support cancellation
 *   8. execute (+ bounded retries)
 *   9. validate output
 *   10. sanitize result
 *   11. record metrics
 *   12. emit audit event
 *   13. return typed result
 *
 * Execution failures are typed. No internal stack traces leak to callers.
 */

export interface ToolExecutorOptions {
  readonly registry: ToolRegistry;
  readonly authorizationService: ToolAuthorizationService;
  readonly metrics: ToolMetrics;
  readonly eventLog?: ToolEventLog;
  readonly config: ToolConfig;
  readonly concurrencyGuard?: (toolId: string) => boolean;
}

export class ToolExecutor {
  readonly name = 'tool-executor';

  private readonly registry: ToolRegistry;
  private readonly authorizationService: ToolAuthorizationService;
  private readonly metrics: ToolMetrics;
  private readonly eventLog: ToolEventLog | undefined;
  private readonly concurrencyGuard: (toolId: string) => boolean;

  constructor(options: ToolExecutorOptions) {
    void options.config;
    this.registry = options.registry;
    this.authorizationService = options.authorizationService;
    this.metrics = options.metrics;
    this.eventLog = options.eventLog;
    this.concurrencyGuard = options.concurrencyGuard ?? (() => true);
  }

  /** Executes a named tool with the given input and context. */
  async execute(name: string, input: unknown, context: ToolExecutionContext): Promise<ToolResult> {
    const executionId = createExecutionId();
    const startedAt = Date.now();

    // 1. Resolve registered tool
    const live = this.registry.getLive(name);
    if (live === undefined) {
      return this.result(
        context,
        executionId,
        name,
        ToolResultStatus.NotFound,
        'TOOL_NOT_FOUND',
        'Tool not found',
        startedAt,
      );
    }
    const tool = live.definition;
    const handler = live.handler;

    // 2. Verify enabled state
    if (tool.enabled !== true) {
      return this.result(
        context,
        executionId,
        tool,
        ToolResultStatus.Disabled,
        'TOOL_DISABLED',
        'Tool is disabled',
        startedAt,
      );
    }

    // 3. Verify authorization
    const decision = this.authorizationService.authorize({
      actor: context.actor,
      permission: ToolPermission.Execute,
      target: {
        toolId: tool.id,
        toolName: tool.name,
        toolVersion: tool.version,
        namespace: context.namespace,
        securityLevel: tool.securityLevel,
        enabled: tool.enabled,
        category: tool.category,
      },
    });
    if (!decision.allowed) {
      this.metrics.record(tool.id, ToolResultStatus.AuthorizationFailed, Date.now() - startedAt);
      this.emitEvent({
        type: ToolEventType.AuthorizationDenied,
        traceId: context.traceId ?? createTraceId(),
        occurredAt: nowIso(),
        namespace: context.namespace,
        toolId: tool.id,
        toolName: tool.name,
        toolVersion: tool.version,
        executionId,
        actorGroup: context.actor.group,
        actorId: context.actor.id,
        requestId: context.requestId,
        correlationId: context.correlationId,
        source: 'security',
        service: 'tool-executor',
        status: ToolResultStatus.AuthorizationFailed,
        errorCode: decision.code,
        reason: decision.reason,
      });
      return this.result(
        context,
        executionId,
        tool,
        ToolResultStatus.AuthorizationFailed,
        decision.code ?? 'TOOL_AUTHORIZATION_FAILED',
        decision.reason ?? 'Not authorized',
        startedAt,
      );
    }

    // 4. Validate input
    const resolver = this.resolveExecutionPolicy(tool);
    const inputValidator = new ToolInputValidator(tool.inputSchema);
    const validation = inputValidator.validate(input);
    if (!validation.ok) {
      this.metrics.record(tool.id, ToolResultStatus.ValidationFailed, Date.now() - startedAt);
      this.emitExecutionEvent(
        context,
        executionId,
        tool,
        ToolResultStatus.ValidationFailed,
        'TOOL_INPUT_VALIDATION_FAILED',
        startedAt,
      );
      return this.result(
        context,
        executionId,
        tool,
        ToolResultStatus.ValidationFailed,
        'TOOL_INPUT_VALIDATION_FAILED',
        'Input validation failed',
        startedAt,
      );
    }

    const validatedInput = validation.value;

    // 5. Enforce execution policy (input size)
    const inputBytes = estimateBytes(validatedInput);
    if (inputBytes > resolver.maxInputBytes) {
      this.metrics.record(tool.id, ToolResultStatus.ValidationFailed, Date.now() - startedAt);
      return this.result(
        context,
        executionId,
        tool,
        ToolResultStatus.ValidationFailed,
        'TOOL_INPUT_TOO_LARGE',
        'Input exceeds max size',
        startedAt,
      );
    }

    // Enforce concurrency (advisory)
    if (resolver.concurrencyLimit !== undefined && !this.concurrencyGuard(tool.id)) {
      this.metrics.record(tool.id, ToolResultStatus.ExecutionFailed, Date.now() - startedAt);
      return this.result(
        context,
        executionId,
        tool,
        ToolResultStatus.ExecutionFailed,
        'TOOL_CONCURRENCY_LIMIT',
        'Concurrency limit reached',
        startedAt,
      );
    }

    // Emit started event
    this.emitEvent({
      type: ToolEventType.ExecutionStarted,
      traceId: context.traceId ?? createTraceId(),
      occurredAt: nowIso(),
      namespace: context.namespace,
      toolId: tool.id,
      toolName: tool.name,
      toolVersion: tool.version,
      executionId,
      actorGroup: context.actor.group,
      actorId: context.actor.id,
      requestId: context.requestId,
      correlationId: context.correlationId,
      source: 'execution',
      service: 'tool-executor',
      status: ToolResultStatus.Success,
    });

    const timeoutMs = context.timeoutMs ?? resolver.timeoutMs;
    const maxRetries = resolver.retryPolicy.maxRetries;

    let output: unknown;
    let attempts = 0;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      attempts += 1;
      if (context.signal?.aborted) {
        return this.finishCancelled(context, executionId, tool, startedAt, attempts);
      }
      try {
        // 6-8. Timeout + cancellation + execute
        const outcome = await runWithTimeoutAndCancellation(
          async () => handler.invoke(validatedInput, context),
          {
            timeoutMs,
            signal: context.signal,
            onTimeout: () => {
              this.metrics.record(tool.id, ToolResultStatus.Timeout, Date.now() - startedAt);
              this.emitExecutionEvent(
                context,
                executionId,
                tool,
                ToolResultStatus.Timeout,
                'TOOL_TIMEOUT',
                startedAt,
              );
            },
            onCancel: () => {
              this.emitExecutionEvent(
                context,
                executionId,
                tool,
                ToolResultStatus.Cancelled,
                'TOOL_CANCELLED',
                startedAt,
              );
            },
          },
        );
        if (!outcome.ok) {
          if (outcome.reason === 'timeout') {
            return this.result(
              context,
              executionId,
              tool,
              ToolResultStatus.Timeout,
              'TOOL_TIMEOUT',
              'Execution timed out',
              startedAt,
              attempts,
            );
          }
          return this.result(
            context,
            executionId,
            tool,
            ToolResultStatus.Cancelled,
            'TOOL_CANCELLED',
            'Execution cancelled',
            startedAt,
            attempts,
          );
        }
        output = outcome.value;
        break;
      } catch (error) {
        const classification = classifyToolError(error);
        const retryable = isRetryableClass(classification.errorClass);
        if (error instanceof ToolAccessDeniedError) {
          return this.result(
            context,
            executionId,
            tool,
            ToolResultStatus.AuthorizationFailed,
            'TOOL_AUTHORIZATION_FAILED',
            'Not authorized',
            startedAt,
            attempts,
          );
        }
        if (!retryable || attempt >= maxRetries || context.signal?.aborted) {
          this.metrics.record(tool.id, ToolResultStatus.ExecutionFailed, Date.now() - startedAt);
          this.emitExecutionEvent(
            context,
            executionId,
            tool,
            ToolResultStatus.ExecutionFailed,
            classification.errorClass,
            startedAt,
            attempts,
          );
          return this.result(
            context,
            executionId,
            tool,
            ToolResultStatus.ExecutionFailed,
            'TOOL_EXECUTION_FAILED',
            'Execution failed',
            startedAt,
            attempts,
          );
        }
        // Retry with cancellation-aware deterministic backoff
        await cancellableDelay(
          retryDelayMs(
            attempt,
            resolver.retryPolicy.backoffBaseMs,
            resolver.retryPolicy.backoffMaxMs,
          ),
          context.signal,
        );
      }
    }

    // 9. Validate output
    const outputBytes = estimateBytes(output);
    if (outputBytes > resolver.maxOutputBytes) {
      this.metrics.record(tool.id, ToolResultStatus.ExecutionFailed, Date.now() - startedAt);
      this.emitExecutionEvent(
        context,
        executionId,
        tool,
        ToolResultStatus.ExecutionFailed,
        'TOOL_OUTPUT_TOO_LARGE',
        startedAt,
        attempts,
      );
      return this.result(
        context,
        executionId,
        tool,
        ToolResultStatus.ExecutionFailed,
        'TOOL_OUTPUT_TOO_LARGE',
        'Output exceeds max size',
        startedAt,
        attempts,
      );
    }
    const outputValidator = new ToolOutputValidator(tool.outputSchema);
    const outputValidation = outputValidator.validate(output);
    if (!outputValidation.ok) {
      this.metrics.record(tool.id, ToolResultStatus.ExecutionFailed, Date.now() - startedAt);
      this.emitExecutionEvent(
        context,
        executionId,
        tool,
        ToolResultStatus.ExecutionFailed,
        'TOOL_OUTPUT_VALIDATION_FAILED',
        startedAt,
        attempts,
      );
      return this.result(
        context,
        executionId,
        tool,
        ToolResultStatus.ExecutionFailed,
        'TOOL_OUTPUT_VALIDATION_FAILED',
        'Output validation failed',
        startedAt,
        attempts,
      );
    }

    // 10. Sanitize result (never leaks secrets)
    // 11. Record metrics
    const duration = Date.now() - startedAt;
    this.metrics.record(tool.id, ToolResultStatus.Success, duration);
    this.emitExecutionEvent(
      context,
      executionId,
      tool,
      ToolResultStatus.Success,
      undefined,
      startedAt,
      attempts,
    );

    const sanitizedOutput = sanitizeToolOutput(outputValidation.value) as ToolJsonValue;
    return {
      toolId: tool.id,
      toolName: tool.name,
      toolVersion: tool.version,
      executionId,
      durationMs: duration,
      status: ToolResultStatus.Success,
      output: sanitizedOutput,
      attempts,
    };
  }

  /** Returns a typed result without executing. */
  private result(
    context: ToolExecutionContext,
    executionId: string,
    tool: ToolDefinition | string,
    status: ToolResultStatus,
    errorCode: string,
    errorMessage: string,
    startedAt: number,
    attempts?: number,
  ): ToolResult {
    void context;
    const duration = Date.now() - startedAt;
    if (typeof tool !== 'string') {
      this.metrics.record(tool.id, status, duration);
    }
    return {
      toolId: typeof tool === 'string' ? tool : tool.id,
      toolName: typeof tool === 'string' ? '' : tool.name,
      toolVersion: typeof tool === 'string' ? '' : tool.version,
      executionId,
      durationMs: duration,
      status,
      errorCode,
      errorMessage,
      attempts,
    };
  }

  private finishCancelled(
    context: ToolExecutionContext,
    executionId: string,
    tool: ToolDefinition,
    startedAt: number,
    attempts: number,
  ): ToolResult {
    this.metrics.record(tool.id, ToolResultStatus.Cancelled, Date.now() - startedAt);
    return this.result(
      context,
      executionId,
      tool,
      ToolResultStatus.Cancelled,
      'TOOL_CANCELLED',
      'Execution cancelled',
      startedAt,
      attempts,
    );
  }

  private resolveExecutionPolicy(tool: ToolDefinition): {
    timeoutMs: number;
    maxInputBytes: number;
    maxOutputBytes: number;
    retryPolicy: { maxRetries: number; backoffBaseMs: number; backoffMaxMs: number };
    concurrencyLimit?: number;
  } {
    return {
      timeoutMs: tool.executionPolicy.timeoutMs,
      maxInputBytes: tool.executionPolicy.maxInputBytes,
      maxOutputBytes: tool.executionPolicy.maxOutputBytes,
      retryPolicy: tool.executionPolicy.retryPolicy,
      concurrencyLimit: tool.executionPolicy.concurrencyLimit,
    };
  }

  private emitExecutionEvent(
    context: ToolExecutionContext,
    executionId: string,
    tool: ToolDefinition,
    status: ToolResultStatus,
    errorCode: string | undefined,
    startedAt: number,
    attempts?: number,
  ): void {
    this.emitEvent({
      type: executionEventType(status),
      traceId: context.traceId ?? createTraceId(),
      occurredAt: nowIso(),
      namespace: context.namespace,
      toolId: tool.id,
      toolName: tool.name,
      toolVersion: tool.version,
      executionId,
      actorGroup: context.actor.group,
      actorId: context.actor.id,
      requestId: context.requestId,
      correlationId: context.correlationId,
      source: 'execution',
      service: 'tool-executor',
      status,
      errorCode,
      metadata: {
        durationMs: Date.now() - startedAt,
        attempts: attempts ?? 1,
      },
    });
  }

  private emitEvent(event: ToolEvent): void {
    if (this.eventLog === undefined) return;
    try {
      this.eventLog.append(event);
    } catch {
      // Event persistence failure must not change the execution result.
      // The failed event is logged (via the caller) but the execution outcome
      // is preserved. See docs/sprint16-tool-manager-v1.md §"Event Failure Policy".
    }
  }
}

function executionEventType(status: ToolResultStatus): ToolEventType {
  switch (status) {
    case ToolResultStatus.Success:
      return ToolEventType.ExecutionSucceeded;
    case ToolResultStatus.Timeout:
      return ToolEventType.ExecutionTimeout;
    case ToolResultStatus.Cancelled:
      return ToolEventType.ExecutionCancelled;
    case ToolResultStatus.AuthorizationFailed:
      return ToolEventType.AuthorizationDenied;
    default:
      return ToolEventType.ExecutionFailed;
  }
}

/** Deterministic UTF-8 byte estimate for a JSON-able payload. */
function estimateBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return 0;
  }
}
