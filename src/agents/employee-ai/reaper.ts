import { rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { EmployeeTaskRepository } from './storage/interface.js';
import type { EmployeeTaskRecord } from './storage/types.js';

/**
 * Prompts19 Phase 2 — periodic cleanup of expired AI Employee tasks, artifacts
 * and their on-disk workspaces.
 *
 * The reaper is deliberately best-effort and idempotent: a failure to remove a
 * workspace never extends a TTL or resurrects a record. Workspace removal is
 * fail-closed — a path that would escape the configured root is skipped rather
 * than followed, so a malformed record can never delete anything outside the
 * employee workspace tree.
 */
export interface EmployeeReaperOptions {
  readonly repository: EmployeeTaskRepository;
  /** Absolute base directory holding `<root>/<project>/<task>` workspaces. */
  readonly workspacesRoot: string;
  readonly intervalMs: number;
  readonly logger?: { error: (obj: object, msg: string) => void };
  /** Injectable clock for tests. */
  readonly now?: () => number;
}

export class EmployeeReaper {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(private readonly options: EmployeeReaperOptions) {}

  /** Run one sweep immediately, then schedule further sweeps. */
  start(): void {
    void this.sweep();
    this.timer = setInterval(() => void this.sweep(), this.options.intervalMs);
    // Never keep the event loop alive purely for the reaper.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Remove expired records/artifacts and their workspaces. Returns swept count. */
  async sweep(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const now = this.options.now?.() ?? Date.now();
      const evicted = await this.options.repository.reap(now);
      for (const record of evicted) {
        await this.removeWorkspace(record);
      }
      return evicted.length;
    } catch (error) {
      this.options.logger?.error(
        { error: error instanceof Error ? error.message : String(error) },
        'employee reaper sweep failed',
      );
      return 0;
    } finally {
      this.running = false;
    }
  }

  private workspacePathFor(record: EmployeeTaskRecord): string | undefined {
    const safe = (value: string): boolean =>
      value.length > 0 && !isAbsolute(value) && !/[\\/]|\.\./.test(value);
    if (!safe(record.projectId) || !record.taskId.startsWith('emp-')) return undefined;
    const root = resolve(this.options.workspacesRoot);
    const target = resolve(join(this.options.workspacesRoot, record.projectId, record.taskId));
    const rel = relative(root, target);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return undefined;
    return target;
  }

  private async removeWorkspace(record: EmployeeTaskRecord): Promise<void> {
    const workspace = this.workspacePathFor(record);
    if (workspace === undefined) {
      this.options.logger?.error(
        { taskId: record.taskId },
        'employee reaper skipped unsafe workspace path',
      );
      return;
    }
    try {
      await rm(workspace, { recursive: true, force: true });
    } catch (error) {
      this.options.logger?.error(
        { taskId: record.taskId, error: error instanceof Error ? error.message : String(error) },
        'employee reaper could not remove workspace',
      );
    }
  }
}
