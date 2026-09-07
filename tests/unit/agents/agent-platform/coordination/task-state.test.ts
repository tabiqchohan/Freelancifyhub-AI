import { describe, expect, it } from 'vitest';

import {
  applyTransition,
  canTransition,
  markTaskCancelled,
  markTaskCompleted,
  markTaskFailed,
  markTaskReady,
  markTaskRunning,
  markTaskSkipped,
  markTaskTimedOut,
} from '../../../../../src/agents/agent-platform/coordination/task-state.js';
import { CoordinationIllegalStateError } from '../../../../../src/agents/agent-platform/coordination/errors.js';
import { TaskStatus } from '../../../../../src/agents/agent-platform/coordination/types.js';

describe('task-state (Sprint 20 §4)', () => {
  it('grants PENDING -> READY -> RUNNING -> COMPLETED', () => {
    expect(markTaskReady('t1', TaskStatus.Pending).allowed).toBe(true);
    expect(markTaskRunning('t1', TaskStatus.Ready).allowed).toBe(true);
    expect(markTaskCompleted('t1', TaskStatus.Running).allowed).toBe(true);
  });

  it('forbids illegal transitions with explicit reasons', () => {
    expect(canTransition('t1', TaskStatus.Pending, TaskStatus.Completed).allowed).toBe(false);
    expect(canTransition('t1', TaskStatus.Pending, TaskStatus.Completed).reason).toContain(
      'illegal',
    );
    expect(canTransition('t1', TaskStatus.Ready, TaskStatus.Ready).reason).toContain('already');
  });

  it('terminal states are immutable', () => {
    expect(canTransition('t1', TaskStatus.Completed, TaskStatus.Running).allowed).toBe(false);
    expect(canTransition('t1', TaskStatus.Failed, TaskStatus.TimedOut).allowed).toBe(false);
    expect(canTransition('t1', TaskStatus.Skipped, TaskStatus.Ready).allowed).toBe(false);
    expect(canTransition('t1', TaskStatus.Cancelled, TaskStatus.Completed).allowed).toBe(false);
    expect(canTransition('t1', TaskStatus.TimedOut, TaskStatus.Completed).allowed).toBe(false);
  });

  it('supports direct cancellation and skipping from pre-start states', () => {
    expect(markTaskCancelled('t1', TaskStatus.Pending).allowed).toBe(true);
    expect(markTaskCancelled('t1', TaskStatus.Running).allowed).toBe(true);
    expect(markTaskSkipped('t1', TaskStatus.Ready).allowed).toBe(true);
  });

  it('supports running -> failed and running -> timed out', () => {
    expect(markTaskFailed('t1', TaskStatus.Running).allowed).toBe(true);
    expect(markTaskTimedOut('t1', TaskStatus.Running).allowed).toBe(true);
  });

  it('applyTransition throws the typed illegal-state error', () => {
    expect(() =>
      applyTransition({ taskId: 't1', from: TaskStatus.Pending, to: TaskStatus.Completed }),
    ).toThrow(CoordinationIllegalStateError);
  });
});
