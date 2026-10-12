/** Prompts17 — typed AI Employee failures (stable codes for the Hub). */

export const EmployeeErrorCode = {
  DISABLED: 'AI_EMPLOYEE_DISABLED',
  REQUEST_TOO_LARGE: 'AI_EMPLOYEE_REQUEST_TOO_LARGE',
  UNSUPPORTED_SCOPE: 'AI_EMPLOYEE_UNSUPPORTED_SCOPE',
  REQUIREMENTS_FAILED: 'AI_EMPLOYEE_REQUIREMENTS_FAILED',
  WORKSPACE_ESCAPE: 'AI_EMPLOYEE_WORKSPACE_ESCAPE',
  RESOURCE_LIMIT: 'AI_EMPLOYEE_RESOURCE_LIMIT',
  VALIDATION_FAILED: 'AI_EMPLOYEE_VALIDATION_FAILED',
  NOT_FOUND: 'AI_EMPLOYEE_NOT_FOUND',
  CANCELLED: 'AI_EMPLOYEE_CANCELLED',
  TIMED_OUT: 'AI_EMPLOYEE_TIMED_OUT',
  INTERNAL: 'AI_EMPLOYEE_INTERNAL',
} as const;
export type EmployeeErrorCodeValue = (typeof EmployeeErrorCode)[keyof typeof EmployeeErrorCode];

export class EmployeeError extends Error {
  constructor(
    public readonly code: EmployeeErrorCodeValue,
    message: string,
    public readonly detail?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'EmployeeError';
  }
}

export function isEmployeeError(error: unknown): error is EmployeeError {
  return error instanceof EmployeeError;
}
