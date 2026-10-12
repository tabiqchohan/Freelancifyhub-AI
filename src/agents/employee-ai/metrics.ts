/** Prompts17 — lightweight AI Employee usage counters (billing groundwork). */

export interface EmployeeMetrics {
  tasksStarted: number;
  tasksSucceeded: number;
  tasksFailed: number;
  tasksCancelled: number;
  tasksTimedOut: number;
  toolCalls: number;
  filesCreated: number;
  bytesWritten: number;
  repairAttempts: number;
}

export function createEmployeeMetrics(initial: EmployeeMetrics): {
  readonly snapshot: () => EmployeeMetrics;
  readonly add: (patch: Partial<EmployeeMetrics>) => void;
} {
  const counters: EmployeeMetrics = { ...initial };
  return {
    snapshot: () => ({ ...counters }),
    add(patch: Partial<EmployeeMetrics>): void {
      Object.assign(
        counters,
        Object.fromEntries(
          Object.entries(patch).map(([key, value]) => [
            key,
            (counters as EmployeeMetrics)[key as keyof EmployeeMetrics] + (value ?? 0),
          ]),
        ),
      );
    },
  };
}
