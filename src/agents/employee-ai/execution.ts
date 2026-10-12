import { join } from 'node:path';
import type { ToolExecutionContext, ToolResult } from '../ag-004-tool-manager/types/index.js';
import {
  ToolActorGroup,
  ToolResultStatus,
  ToolSecurityLevel,
} from '../ag-004-tool-manager/enums/index.js';
import type { EmployeeConfig } from './config.js';
import { EmployeeError, EmployeeErrorCode } from './errors.js';
import { generateStaticSite } from './generator.js';
import { buildExecutionPlan, extractRequirements } from './requirements.js';
import { classifyScope } from './scope.js';
import { WorkspaceManager } from './workspace.js';
import {
  EMPLOYEE_BUILD_TOOL,
  EMPLOYEE_PACKAGE_TOOL,
  EMPLOYEE_VALIDATE_TOOL,
  EMPLOYEE_WRITE_TOOL,
} from './tools.js';
import type { EmployeeEvent, EmployeeEventSink } from './events.js';
import { EmployeeEventType } from './events.js';
import type {
  ArtifactInfo,
  EmployeePhaseValue,
  EmployeeResult,
  ValidationReport,
  WebsiteTaskInput,
} from './types.js';
import { EmployeePhase, EmployeeScopeTier } from './types.js';

/**
 * Prompts17 Phase 18 — Employee execution pipeline.
 *
 * Concrete order of work per task:
 *   REQUESTED -> REQUIREMENTS -> PLANNING -> EXECUTING -> VALIDATING
 *   -> (REPAIRING up to bound) -> PACKAGING -> READY_FOR_REVIEW.
 *
 * Every real mutation goes through an AG-004-registered tool (the four
 * `employee.workspace.*` tools); the executor itself never touches the
 * filesystem. A shared AbortSignal carries the caller's cancel AND the overall
 * deadline (distinguishable via a `timedOut` latch), and the bounded repair
 * loop re-runs the deterministic assembly until validation passes or the
 * budget is exhausted.
 */

/** Narrow execution seam so tests can inject a fake product of AG-004. */
export interface EmployeeToolGateway {
  execute(name: string, input: unknown, context: ToolExecutionContext): Promise<ToolResult>;
}

export interface EmployeeExecutorOptions {
  readonly config: EmployeeConfig;
  /** Absolute base directory holding `<root>/<project>/<task>` workspaces. */
  readonly workspacesRoot: string;
  /** AG-004 ToolManagerService (structurally satisfies the gateway). */
  readonly toolManager: EmployeeToolGateway;
  /** Shared per-task tool-call budget, also enforced inside the tools. */
  readonly budget: TaskToolBudget;
  readonly events: EmployeeEventSink;
}

export interface EmployeeExecutionResult {
  readonly result: EmployeeResult;
  readonly artifactPath?: string;
}

/** Per-task tool-call budget enforced at the tool boundary. */
export class TaskToolBudget {
  private readonly calls = new Map<string, number>();

  track(taskId: string, max: number): void {
    const current = this.calls.get(taskId) ?? 0;
    if (current >= max) {
      throw new EmployeeError(
        EmployeeErrorCode.RESOURCE_LIMIT,
        'employee tool-call budget exhausted',
        {
          taskId,
          calls: current,
          max,
        },
      );
    }
    this.calls.set(taskId, current + 1);
  }

  count(taskId: string): number {
    return this.calls.get(taskId) ?? 0;
  }

  clear(taskId: string): void {
    this.calls.delete(taskId);
  }
}

function artifactPathFor(fileName: string): string {
  return `artifacts/${fileName}`;
}

export class EmployeeExecutor {
  constructor(private readonly options: EmployeeExecutorOptions) {}

  private emit(event: EmployeeEvent): void {
    this.options.events.emit(event);
  }

  private async runTool(
    name: string,
    input: Record<string, unknown>,
    projectId: string,
    taskId: string,
    signal: AbortSignal,
    requestId: string,
    traceId: string,
  ): Promise<ToolResult> {
    if (signal.aborted) {
      throw new EmployeeError(EmployeeErrorCode.CANCELLED, 'cancelled before tool invocation');
    }
    const result = await this.options.toolManager.execute(name, input, {
      actor: {
        group: ToolActorGroup.Orchestrator,
        id: 'ag-701',
        type: 'employee-website-developer',
        namespaces: [`employee:${projectId}:${taskId}`],
        securityClearance: ToolSecurityLevel.Confidential,
      },
      namespace: `employee:${projectId}:${taskId}`,
      requestId,
      traceId,
      agentId: 'ag-701',
      signal,
    });
    if (result.status === ToolResultStatus.Cancelled) {
      throw new EmployeeError(EmployeeErrorCode.CANCELLED, 'tool invocation was cancelled', {
        tool: name,
      });
    }
    if (result.status === ToolResultStatus.Timeout) {
      throw new EmployeeError(EmployeeErrorCode.TIMED_OUT, `tool invocation timed out`, {
        tool: name,
      });
    }
    if (result.status !== ToolResultStatus.Success) {
      throw new EmployeeError(EmployeeErrorCode.VALIDATION_FAILED, `tool invocation failed`, {
        tool: name,
        status: result.status,
        code: result.errorCode,
      });
    }
    return result;
  }

  async executeTask(
    input: WebsiteTaskInput,
    requestId: string,
    traceId: string,
    callerSignal?: AbortSignal,
  ): Promise<EmployeeExecutionResult> {
    const startedAt = Date.now();
    const config = this.options.config;
    const { projectId, clientId, taskId, requestText } = input;
    const budget = this.options.budget;
    const workspace = new WorkspaceManager(
      join(this.options.workspacesRoot, projectId, taskId),
      config,
    );

    const controller = new AbortController();
    const deadlineState = { timedOut: false };
    const forwardAbort = () => controller.abort();
    callerSignal?.addEventListener('abort', forwardAbort, { once: true });
    const deadlineTimer = setTimeout(() => {
      deadlineState.timedOut = true;
      controller.abort();
    }, config.EMPLOYEE_MAX_EXECUTION_MS);
    const signal = controller.signal;
    const cleanup = () => {
      clearTimeout(deadlineTimer);
      callerSignal?.removeEventListener('abort', forwardAbort);
    };

    const run = (name: string, toolInput: Record<string, unknown>): Promise<ToolResult> => {
      budget.track(taskId, config.EMPLOYEE_MAX_TOOL_CALLS);
      return this.runTool(name, toolInput, projectId, taskId, signal, requestId, traceId);
    };

    const finishResult = (
      overrides: Partial<EmployeeResult> & { phase: EmployeePhaseValue; summary: string },
    ): EmployeeResult => ({
      status: overrides.phase,
      filesCreated: 0,
      bytesWritten: 0,
      repairAttempts: 0,
      toolCalls: budget.count(taskId),
      warnings: [
        'Static site only: React/Next.js and shell/npm builds are not executed because no sandboxed build runner is available (documented blocker).',
      ],
      nextActions: ['Review the artifact bundle on the project page and request changes.'],
      durationMs: Date.now() - startedAt,
      ...overrides,
    });

    this.emit({
      type: EmployeeEventType.STARTED,
      taskId,
      projectId,
      clientId,
      metadata: { requestId },
    });

    try {
      await workspace.reset();

      const scope = classifyScope(requestText);
      if (scope.tier !== EmployeeScopeTier.STATIC_SITE) {
        const result = finishResult({
          phase: EmployeePhase.FAILED,
          summary: 'This request is outside what the employee can build safely today.',
          error: { code: EmployeeErrorCode.UNSUPPORTED_SCOPE, message: scope.reason },
          nextActions: [
            'The website developer currently accepts static, multi-page websites only.',
            'React/Next.js and backend/database work require a sandboxed build runner that is not yet available.',
          ],
        });
        cleanup();
        return { result };
      }

      this.emit({
        type: EmployeeEventType.STAGE,
        taskId,
        projectId,
        clientId,
        metadata: { stage: EmployeePhase.REQUIREMENTS },
      });
      const spec = extractRequirements(requestText);
      const plan = buildExecutionPlan(spec);

      this.emit({
        type: EmployeeEventType.STAGE,
        taskId,
        projectId,
        clientId,
        metadata: { stage: EmployeePhase.PLANNING },
      });

      const generated = generateStaticSite(spec);
      let bytesWritten = 0;
      for (const file of generated) {
        const out = await run(EMPLOYEE_WRITE_TOOL, {
          project: projectId,
          task: taskId,
          path: file.relativePath,
          content: file.content,
        });
        const parsed = out.output as { readonly bytes?: number } | undefined;
        if (typeof parsed?.bytes !== 'number') {
          throw new EmployeeError(EmployeeErrorCode.INTERNAL, 'write tool returned no byte count', {
            file: file.relativePath,
          });
        }
        bytesWritten += parsed.bytes;
      }

      const pageSlugs = spec.pages.map((page) => ({ slug: page.slug }));
      await run(EMPLOYEE_BUILD_TOOL, { project: projectId, task: taskId, pages: pageSlugs });

      let repairs = 0;
      let validation: ValidationReport | undefined;
      let maxed = false;
      while (true) {
        const validateOut = await run(EMPLOYEE_VALIDATE_TOOL, { project: projectId, task: taskId });
        validation = validateOut.output as unknown as ValidationReport;
        if (validation.passed) break;
        if (repairs >= config.EMPLOYEE_MAX_REPAIR_ATTEMPTS) {
          maxed = true;
          break;
        }
        repairs += 1;
        this.emit({
          type: EmployeeEventType.REPAIR,
          taskId,
          projectId,
          clientId,
          metadata: { attempt: repairs, issues: validation.issues.length },
        });
        for (const file of generated) {
          await run(EMPLOYEE_WRITE_TOOL, {
            project: projectId,
            task: taskId,
            path: file.relativePath,
            content: file.content,
          });
        }
        await run(EMPLOYEE_BUILD_TOOL, { project: projectId, task: taskId, pages: pageSlugs });
      }

      if (maxed || validation === undefined || !validation.passed) {
        this.emit({
          type: EmployeeEventType.REPAIR_EXHAUSTED,
          taskId,
          projectId,
          clientId,
          metadata: { repairs },
        });
        const result = finishResult({
          phase: EmployeePhase.FAILED,
          summary:
            'Validation did not pass within the repair budget; the artifact was not delivered.',
          validation,
          repairAttempts: repairs,
          error: {
            code: EmployeeErrorCode.VALIDATION_FAILED,
            message: `validation failed after ${repairs} repair attempt(s)`,
          },
        });
        this.emit({
          type: EmployeeEventType.FAILED,
          taskId,
          projectId,
          clientId,
          metadata: { error: result.error?.code },
        });
        cleanup();
        return { result };
      }

      const packageOut = await run(EMPLOYEE_PACKAGE_TOOL, { project: projectId, task: taskId });
      const artifact = packageOut.output as unknown as ArtifactInfo;

      const result = finishResult({
        phase: EmployeePhase.READY_FOR_REVIEW,
        summary: `${spec.pages.length} pages built, validated and packaged for review.`,
        siteSpec: spec,
        plan,
        validation,
        artifact,
        filesCreated: generated.length,
        bytesWritten,
        repairAttempts: repairs,
        nextActions: [
          'Download the review artifact on the project page.',
          'Request changes to the content or structure; the employee will rebuild a bounded, validated site.',
        ],
      });

      this.emit({
        type: EmployeeEventType.SUCCEEDED,
        taskId,
        projectId,
        clientId,
        metadata: { files: result.filesCreated, bytes: result.bytesWritten, repairs },
      });
      return { result, artifactPath: workspace.resolve(artifactPathFor(artifact.fileName)) };
    } catch (error) {
      const fromDeadline = deadlineState.timedOut;
      const cancelled =
        error instanceof EmployeeError &&
        (error.code === EmployeeErrorCode.CANCELLED ||
          error.code === EmployeeErrorCode.TIMED_OUT ||
          fromDeadline);
      const phase: EmployeePhaseValue = cancelled
        ? fromDeadline
          ? EmployeePhase.TIMED_OUT
          : error instanceof EmployeeError && error.code === EmployeeErrorCode.TIMED_OUT
            ? EmployeePhase.TIMED_OUT
            : EmployeePhase.CANCELED
        : EmployeePhase.FAILED;
      const code = cancelled
        ? fromDeadline
          ? EmployeeErrorCode.TIMED_OUT
          : error instanceof EmployeeError &&
              (error.code === EmployeeErrorCode.CANCELLED ||
                error.code === EmployeeErrorCode.TIMED_OUT)
            ? error.code
            : EmployeeErrorCode.CANCELLED
        : error instanceof EmployeeError
          ? error.code
          : EmployeeErrorCode.INTERNAL;
      const result = finishResult({
        phase,
        summary: cancelled
          ? 'The task was cancelled or timed out.'
          : 'The employee could not complete the task.',
        error: { code, message: error instanceof Error ? error.message.slice(0, 300) : code },
        repairAttempts: 0,
      });
      this.emit({
        type: cancelled
          ? code === EmployeeErrorCode.TIMED_OUT
            ? EmployeeEventType.TIMED_OUT
            : EmployeeEventType.CANCELLED
          : EmployeeEventType.FAILED,
        taskId,
        projectId,
        clientId,
        metadata: { error: code },
      });
      return { result };
    } finally {
      budget.clear(taskId);
      cleanup();
    }
  }
}
