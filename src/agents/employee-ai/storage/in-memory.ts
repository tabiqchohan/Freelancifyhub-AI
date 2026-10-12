import type { EmployeeTaskRepository } from './interface.js';
import type { EmployeeArtifactBytes, EmployeeTaskRecord } from './types.js';
import { isTerminalPhase } from '../types.js';

interface StoredArtifact {
  readonly artifact: EmployeeArtifactBytes;
  readonly expiresAt: number;
}

/**
 * Prompts19 Phase 2 — process-local implementation of
 * {@link EmployeeTaskRepository} for development and tests. It is explicitly
 * non-durable: {@link durable} is false and the composition root refuses this
 * backend in production.
 */
export class InMemoryEmployeeTaskRepository implements EmployeeTaskRepository {
  readonly durable = false;
  private readonly tasks = new Map<string, EmployeeTaskRecord>();
  private readonly artifacts = new Map<string, StoredArtifact>();

  async migrate(): Promise<void> {
    /* no schema for the in-memory backend */
  }

  async saveTask(record: EmployeeTaskRecord): Promise<void> {
    this.tasks.set(record.taskId, record);
  }

  async getTask(taskId: string): Promise<EmployeeTaskRecord | undefined> {
    return this.tasks.get(taskId);
  }

  async listTasks(limit = 200): Promise<EmployeeTaskRecord[]> {
    return [...this.tasks.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, Math.max(0, limit));
  }

  async listNonTerminal(): Promise<EmployeeTaskRecord[]> {
    return [...this.tasks.values()].filter((t) => !isTerminalPhase(t.phase));
  }

  async deleteTask(taskId: string): Promise<void> {
    this.tasks.delete(taskId);
  }

  async saveArtifact(
    taskId: string,
    artifact: EmployeeArtifactBytes,
    expiresAt: number,
  ): Promise<void> {
    this.artifacts.set(taskId, { artifact, expiresAt });
  }

  async getArtifact(taskId: string): Promise<EmployeeArtifactBytes | undefined> {
    return this.artifacts.get(taskId)?.artifact;
  }

  async deleteArtifact(taskId: string): Promise<void> {
    this.artifacts.delete(taskId);
  }

  async reap(now: number): Promise<EmployeeTaskRecord[]> {
    for (const [taskId, stored] of this.artifacts) {
      if (stored.expiresAt <= now) this.artifacts.delete(taskId);
    }
    const evicted: EmployeeTaskRecord[] = [];
    for (const [taskId, record] of this.tasks) {
      if (record.expiresAt <= now) {
        evicted.push(record);
        this.tasks.delete(taskId);
        this.artifacts.delete(taskId);
      }
    }
    return evicted;
  }

  async health(): Promise<{ healthy: boolean; message: string }> {
    return { healthy: true, message: 'in-memory employee repository healthy' };
  }

  async close(): Promise<void> {
    this.tasks.clear();
    this.artifacts.clear();
  }
}
