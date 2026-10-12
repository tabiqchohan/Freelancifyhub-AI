import type { Logger } from 'pino';

/**
 * Prompts17 Phase 18 — AI Employee lifecycle events.
 *
 * The executor emits a deterministic, bounded event stream so the runtime
 * (and, downstream, the Hub) can trace a task through every pipeline stage:
 * REQUESTED -> REQUIREMENTS -> PLANNING -> EXECUTING -> VALIDATING/REPAIRING
 * -> PACKAGING -> READY_FOR_REVIEW. Events carry metadata only (never request
 * text or response content).
 */

export const EmployeeEventType = {
  STARTED: 'AI_EMPLOYEE_STARTED',
  STAGE: 'AI_EMPLOYEE_STAGE',
  REPAIR: 'AI_EMPLOYEE_REPAIR',
  REPAIR_EXHAUSTED: 'AI_EMPLOYEE_REPAIR_EXHAUSTED',
  SUCCEEDED: 'AI_EMPLOYEE_SUCCEEDED',
  FAILED: 'AI_EMPLOYEE_FAILED',
  CANCELLED: 'AI_EMPLOYEE_CANCELLED',
  TIMED_OUT: 'AI_EMPLOYEE_TIMED_OUT',
} as const;
export type EmployeeEventTypeValue = (typeof EmployeeEventType)[keyof typeof EmployeeEventType];

export interface EmployeeEvent {
  readonly type: EmployeeEventTypeValue;
  readonly taskId: string;
  readonly projectId: string;
  readonly clientId: string;
  /** Stable metadata only — never request text or artifact content. */
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface EmployeeEventSink {
  emit(event: EmployeeEvent): void;
}

export function pinoEmployeeEventSink(logger: Logger): EmployeeEventSink {
  return {
    emit(event: EmployeeEvent): void {
      logger.info(
        {
          event: event.type,
          taskId: event.taskId,
          projectId: event.projectId,
          clientId: event.clientId,
          meta: event.metadata,
        },
        'AI employee event',
      );
    },
  };
}
