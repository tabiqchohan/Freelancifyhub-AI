import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { EmployeeConfig } from './config.js';
import { EmployeeError, EmployeeErrorCode } from './errors.js';
import type { EmployeeErrorCodeValue } from './errors.js';
import type { EmployeeExecutor } from './execution.js';
import type { EmployeeEventSink } from './events.js';
import { EmployeeEventType } from './events.js';
import type { EmployeeMetrics } from './metrics.js';
import { createEmployeeMetrics } from './metrics.js';
import { InMemoryEmployeeTaskRepository } from './storage/in-memory.js';
import type { EmployeeTaskRepository } from './storage/interface.js';
import type { EmployeeArtifactBytes, EmployeeTaskRecord } from './storage/types.js';
import { EmployeePhase, type EmployeeResult } from './types.js';
import type {
  EmployeeRunRequest,
  EmployeeRunResponse,
  EmployeeStatusResponse,
  EmployeeArtifactResponse,
  WebsiteTaskInput,
} from './types.js';

const MAX_RETAINED_RESULTS = 100;

interface ActiveTask {
  readonly input: WebsiteTaskInput;
  readonly requestId: string;
  readonly traceId: string;
  readonly startedAt: number;
  readonly abort: AbortController;
  state: 'QUEUED' | 'RUNNING';
}

interface StoredTask {
  readonly input: WebsiteTaskInput;
  readonly result: EmployeeResult & { readonly artifactPath?: string };
}

export interface EmployeeServiceOptions {
  readonly config: EmployeeConfig;
  readonly executor: EmployeeExecutor;
  readonly events: EmployeeEventSink;
  readonly repository?: EmployeeTaskRepository;
  readonly logger?: { error: (obj: object, msg: string) => void };
}

/**
 * Prompts19 Phase 2/3/4 — AI Employee task service.
 *
 * Task state is write-through to a {@link EmployeeTaskRepository}: accepted
 * tasks are persisted before they are acknowledged, terminal results (and their
 * reviewed ZIP bytes) are persisted when the pipeline finishes, and
 * {@link hydrate} rebuilds the bounded in-memory cache on startup so status and
 * artifacts survive a restart. The in-memory working set is only a bounded
 * cache; the repository is the source of truth when durable.
 *
 * Admission is controlled by bounded concurrency + queue capacity. A bounded
 * queue holds accepted work; overflow is rejected with a resource-limit error
 * (backpressure) rather than queued without bound. Queued tasks are not resumed
 * after a restart: {@link hydrate} marks them FAILED so no task is ever stuck.
 */
export class EmployeeService {
  private readonly active = new Map<string, ActiveTask>();
  private readonly queue: string[] = [];
  private readonly done = new Map<string, StoredTask>();
  private readonly repository: EmployeeTaskRepository;

  constructor(
    private readonly config: EmployeeConfig,
    private readonly executor: EmployeeExecutor,
    private readonly events: EmployeeEventSink,
    repository?: EmployeeTaskRepository,
    private readonly logger?: { error: (obj: object, msg: string) => void },
  ) {
    this.repository = repository ?? new InMemoryEmployeeTaskRepository();
  }

  enabled(): boolean {
    return this.config.EMPLOYEE_ENABLED;
  }

  durable(): boolean {
    return this.repository.durable;
  }

  repositoryRef(): EmployeeTaskRepository {
    return this.repository;
  }

  activeCount(): number {
    let running = 0;
    for (const task of this.active.values()) {
      if (task.state === 'RUNNING') running += 1;
    }
    return running;
  }

  /**
   * Rebuild in-memory state from durable storage. Tasks left non-terminal by a
   * previous process are marked FAILED (interrupted) so no client sees a task
   * stuck forever; terminal tasks are loaded so their artifacts stay reachable.
   */
  async hydrate(): Promise<void> {
    const now = Date.now();
    const interrupted = await this.repository.listNonTerminal();
    for (const record of interrupted) {
      const result = this.failureResult(
        EmployeeErrorCode.INTERNAL,
        'employee task was interrupted by a restart',
      );
      await this.repository.saveTask({
        ...record,
        phase: result.phase,
        result,
        completedAt: now,
        updatedAt: now,
      });
      this.retain(record.taskId, inputOf(record), result);
    }
    const terminal = await this.repository.listTasks(MAX_RETAINED_RESULTS);
    for (const record of terminal) {
      this.retain(record.taskId, inputOf(record), record.result);
    }
  }

  /** Fail-closed capacity check for global + per-client concurrency limits. */
  private assertServable(clientId: string): void {
    if (!this.config.EMPLOYEE_ENABLED) {
      throw new EmployeeError(EmployeeErrorCode.DISABLED, 'AI Employee subsystem is disabled');
    }
    const inFlight = this.active.size;
    const capacity = this.config.EMPLOYEE_MAX_ACTIVE_TASKS + this.config.EMPLOYEE_QUEUE_CAPACITY;
    if (inFlight >= capacity) {
      throw new EmployeeError(EmployeeErrorCode.RESOURCE_LIMIT, 'employee task queue is full');
    }
    let forClient = 0;
    for (const task of this.active.values()) {
      if (task.input.clientId === clientId) forClient += 1;
    }
    if (forClient >= this.config.EMPLOYEE_MAX_USER_ACTIVE_TASKS) {
      throw new EmployeeError(
        EmployeeErrorCode.RESOURCE_LIMIT,
        'too many active employee tasks for this client',
      );
    }
  }

  private retain(
    taskId: string,
    input: WebsiteTaskInput,
    result: EmployeeResult & { readonly artifactPath?: string },
  ): void {
    this.done.delete(taskId);
    this.done.set(taskId, { input, result });
    let overflow = this.done.size - MAX_RETAINED_RESULTS;
    for (const key of this.done.keys()) {
      if (overflow <= 0) break;
      this.done.delete(key);
      overflow -= 1;
    }
  }

  async execute(request: EmployeeRunRequest): Promise<EmployeeRunResponse> {
    this.assertServable(request.clientId);
    const taskId = `emp-${randomUUID()}`;
    const traceId = request.traceId ?? `trace-${request.requestId}`;
    const input: WebsiteTaskInput = {
      projectId: request.projectId,
      clientId: request.clientId,
      taskId,
      requestText: request.requestText,
    };

    const task: ActiveTask = {
      input,
      requestId: request.requestId,
      traceId,
      startedAt: Date.now(),
      abort: new AbortController(),
      state: 'QUEUED',
    };

    const accepted = this.executingResult('employee task accepted');
    await this.repository.saveTask(
      this.recordFor(task, accepted, {
        expiresAt: Date.now() + this.config.EMPLOYEE_ARTIFACT_TTL_MS,
      }),
    );

    this.active.set(taskId, task);
    this.queue.push(taskId);
    this.pump();

    return { taskId, employee: 'AG-701', result: this.statusOf(taskId) };
  }

  /** Start queued tasks up to the global concurrency limit. */
  private pump(): void {
    while (this.activeCount() < this.config.EMPLOYEE_MAX_ACTIVE_TASKS && this.queue.length > 0) {
      const taskId = this.queue.shift();
      if (taskId === undefined) break;
      const task = this.active.get(taskId);
      if (task === undefined || task.state !== 'QUEUED') continue;
      task.state = 'RUNNING';
      void this.runTask(taskId, task);
    }
  }

  private async runTask(taskId: string, task: ActiveTask): Promise<void> {
    try {
      const outcome = await this.executor.executeTask(
        task.input,
        task.requestId,
        task.traceId,
        task.abort.signal,
      );
      const result =
        outcome.result.artifact !== undefined && outcome.artifactPath !== undefined
          ? { ...outcome.result, artifactPath: outcome.artifactPath }
          : outcome.result;
      this.active.delete(taskId);
      this.retain(taskId, task.input, result);
      await this.persistTerminal(taskId, task, result);
      await this.persistArtifact(taskId, result);
    } catch (error) {
      this.active.delete(taskId);
      const result = this.failureResult(
        EmployeeErrorCode.INTERNAL,
        error instanceof Error ? error.message.slice(0, 300) : 'employee pipeline crashed',
      );
      this.retain(taskId, task.input, result);
      await this.persistTerminal(taskId, task, result);
    } finally {
      // A slot just freed up — start the next queued task, if any.
      this.pump();
    }
  }

  status(taskId: string): EmployeeStatusResponse {
    return { taskId, status: this.statusOf(taskId).phase, result: this.stored(taskId) };
  }

  activeInput(taskId: string): WebsiteTaskInput | undefined {
    return this.active.get(taskId)?.input;
  }

  cancel(taskId: string): boolean {
    const task = this.active.get(taskId);
    if (task === undefined) return false;
    if (task.state === 'QUEUED') {
      const index = this.queue.indexOf(taskId);
      if (index >= 0) this.queue.splice(index, 1);
      this.active.delete(taskId);
      const result = {
        phase: EmployeePhase.CANCELED,
        status: EmployeePhase.CANCELED,
        summary: 'employee task cancelled before execution',
        filesCreated: 0,
        bytesWritten: 0,
        repairAttempts: 0,
        toolCalls: 0,
        warnings: [],
        nextActions: [],
        durationMs: 0,
      } satisfies EmployeeResult;
      this.retain(taskId, task.input, result);
      void this.persistTerminal(taskId, task, result);
    } else {
      task.abort.abort();
    }
    this.events.emit({
      type: EmployeeEventType.CANCELLED,
      taskId,
      projectId: task.input.projectId,
      clientId: task.input.clientId,
      metadata: { requested: true },
    });
    return true;
  }

  /** Returns the packaged artifact only to the owning project/client (authz). */
  async artifact(
    taskId: string,
    projectId: string,
    clientId: string,
  ): Promise<EmployeeArtifactResponse | undefined> {
    const input = this.active.get(taskId)?.input ?? this.done.get(taskId)?.input;
    if (input === undefined || input.projectId !== projectId || input.clientId !== clientId) {
      throw new EmployeeError(
        EmployeeErrorCode.NOT_FOUND,
        'no such employee task for this project/owner',
        { taskId },
      );
    }
    const result = this.done.get(taskId)?.result;
    if (
      result === undefined ||
      result.phase !== EmployeePhase.READY_FOR_REVIEW ||
      result.artifact === undefined
    ) {
      throw new EmployeeError(EmployeeErrorCode.NOT_FOUND, 'no review artifact yet', { taskId });
    }

    const persisted = await this.repository.getArtifact(taskId);
    if (persisted !== undefined) {
      if (persisted.bytes.byteLength > this.config.EMPLOYEE_MAX_ARTIFACT_BYTES) {
        throw new EmployeeError(
          EmployeeErrorCode.RESOURCE_LIMIT,
          'artifact exceeds the configured limit',
        );
      }
      return {
        taskId,
        fileName: persisted.fileName,
        sizeBytes: persisted.bytes.byteLength,
        contentType: 'application/zip',
        base64: persisted.bytes.toString('base64'),
        sha256: persisted.sha256,
      };
    }

    if (result.artifactPath === undefined) {
      throw new EmployeeError(EmployeeErrorCode.NOT_FOUND, 'no review artifact yet', { taskId });
    }
    const raw = await readFile(result.artifactPath);
    if (raw.byteLength > this.config.EMPLOYEE_MAX_ARTIFACT_BYTES) {
      throw new EmployeeError(
        EmployeeErrorCode.RESOURCE_LIMIT,
        'artifact exceeds the configured limit',
      );
    }
    return {
      taskId,
      fileName: result.artifact.fileName,
      sizeBytes: raw.byteLength,
      contentType: 'application/zip',
      base64: raw.toString('base64'),
      sha256: createHash('sha256').update(raw).digest('hex'),
    };
  }

  private recordFor(
    task: ActiveTask,
    result: EmployeeResult & { readonly artifactPath?: string },
    options: { readonly completedAt?: number; readonly expiresAt: number },
  ): EmployeeTaskRecord {
    return {
      taskId: task.input.taskId,
      projectId: task.input.projectId,
      clientId: task.input.clientId,
      requestText: task.input.requestText,
      requestId: task.requestId,
      traceId: task.traceId,
      phase: result.phase,
      result,
      artifactFileName: result.artifact?.fileName,
      artifactSha256: result.artifact?.sha256,
      artifactPath: result.artifactPath,
      startedAt: task.startedAt,
      completedAt: options.completedAt,
      updatedAt: Date.now(),
      expiresAt: options.expiresAt,
    };
  }

  private async persistTerminal(
    taskId: string,
    task: ActiveTask,
    result: EmployeeResult & { readonly artifactPath?: string },
  ): Promise<void> {
    const now = Date.now();
    try {
      await this.repository.saveTask(
        this.recordFor(task, result, {
          completedAt: now,
          expiresAt: now + this.config.EMPLOYEE_ARTIFACT_TTL_MS,
        }),
      );
    } catch (error) {
      this.logger?.error(
        { taskId, error: error instanceof Error ? error.message : String(error) },
        'employee task persistence failed',
      );
    }
  }

  private async persistArtifact(
    taskId: string,
    result: EmployeeResult & { readonly artifactPath?: string },
  ): Promise<void> {
    if (result.phase !== EmployeePhase.READY_FOR_REVIEW) return;
    if (result.artifact === undefined || result.artifactPath === undefined) return;
    try {
      const raw = await readFile(result.artifactPath);
      const artifact: EmployeeArtifactBytes = {
        fileName: result.artifact.fileName,
        sha256: result.artifact.sha256,
        bytes: raw,
      };
      await this.repository.saveArtifact(
        taskId,
        artifact,
        Date.now() + this.config.EMPLOYEE_ARTIFACT_TTL_MS,
      );
    } catch (error) {
      this.logger?.error(
        { taskId, error: error instanceof Error ? error.message : String(error) },
        'employee artifact persistence failed',
      );
    }
  }

  private stored(
    taskId: string,
  ): (EmployeeResult & { readonly artifactPath?: string }) | undefined {
    return this.done.get(taskId)?.result;
  }

  private executingResult(summary: string): EmployeeResult {
    return {
      phase: EmployeePhase.EXECUTING,
      status: EmployeePhase.EXECUTING,
      summary,
      filesCreated: 0,
      bytesWritten: 0,
      repairAttempts: 0,
      toolCalls: 0,
      warnings: [],
      nextActions: [],
      durationMs: 0,
    };
  }

  private failureResult(code: EmployeeErrorCodeValue, message: string): EmployeeResult {
    return {
      phase: EmployeePhase.FAILED,
      status: EmployeePhase.FAILED,
      summary: 'employee pipeline crashed unexpectedly',
      filesCreated: 0,
      bytesWritten: 0,
      repairAttempts: 0,
      toolCalls: 0,
      warnings: [],
      nextActions: [],
      durationMs: 0,
      error: { code, message },
    };
  }

  private statusOf(taskId: string): EmployeeResult {
    const stored = this.done.get(taskId);
    if (stored !== undefined) return stored.result;
    const active = this.active.get(taskId);
    if (active !== undefined) {
      return {
        phase: EmployeePhase.EXECUTING,
        status: EmployeePhase.EXECUTING,
        summary:
          active.state === 'QUEUED' ? 'employee task is queued' : 'employee is working on the task',
        filesCreated: 0,
        bytesWritten: 0,
        repairAttempts: 0,
        toolCalls: 0,
        warnings: [],
        nextActions: [],
        durationMs: Date.now() - active.startedAt,
      };
    }
    return {
      phase: EmployeePhase.FAILED,
      status: EmployeePhase.FAILED,
      summary: 'employee task not found',
      filesCreated: 0,
      bytesWritten: 0,
      repairAttempts: 0,
      toolCalls: 0,
      warnings: [],
      nextActions: [],
      durationMs: 0,
      error: { code: EmployeeErrorCode.NOT_FOUND, message: 'task not found' },
    };
  }

  metricsSnapshot(): EmployeeMetrics {
    let tasksSucceeded = 0;
    let tasksFailed = 0;
    let tasksCancelled = 0;
    let tasksTimedOut = 0;
    let toolCalls = 0;
    let filesCreated = 0;
    let bytesWritten = 0;
    let repairAttempts = 0;
    for (const { result } of this.done.values()) {
      if (result.phase === EmployeePhase.READY_FOR_REVIEW) tasksSucceeded += 1;
      else if (result.phase === EmployeePhase.CANCELED) tasksCancelled += 1;
      else if (result.phase === EmployeePhase.TIMED_OUT) tasksTimedOut += 1;
      else if (result.phase === EmployeePhase.FAILED) tasksFailed += 1;
      toolCalls += result.toolCalls;
      filesCreated += result.filesCreated;
      bytesWritten += result.bytesWritten;
      repairAttempts += result.repairAttempts;
    }
    return createEmployeeMetrics({
      tasksStarted: this.active.size + this.done.size,
      tasksSucceeded,
      tasksFailed,
      tasksCancelled,
      tasksTimedOut,
      toolCalls,
      filesCreated,
      bytesWritten,
      repairAttempts,
    }).snapshot();
  }
}

function inputOf(record: EmployeeTaskRecord): WebsiteTaskInput {
  return {
    projectId: record.projectId,
    clientId: record.clientId,
    taskId: record.taskId,
    requestText: record.requestText,
  };
}
