/**
 * Prompts17 — AI Employee (AG-701 "Website Developer") domain types.
 *
 * These are the stable contracts flow through the whole pipeline:
 * REQUEST -> REQUIREMENTS -> PLAN -> EXECUTION -> ARTIFACT -> VALIDATION -> REVIEW.
 * They are deliberately repository-agnostic so the Hub can classify the shape.
 */

/** One phase of the employee pipeline. */
export const EmployeePhase = {
  REQUESTED: 'REQUESTED',
  REQUIREMENTS: 'REQUIREMENTS',
  PLANNING: 'PLANNING',
  EXECUTING: 'EXECUTING',
  VALIDATING: 'VALIDATING',
  REPAIRING: 'REPAIRING',
  PACKAGING: 'PACKAGING',
  READY_FOR_REVIEW: 'READY_FOR_REVIEW',
  FAILED: 'FAILED',
  CANCELED: 'CANCELED',
  TIMED_OUT: 'TIMED_OUT',
} as const;
export type EmployeePhaseValue = (typeof EmployeePhase)[keyof typeof EmployeePhase];

/** Phases from which no further work happens (a task is finished). */
export const TERMINAL_PHASES: ReadonlyArray<EmployeePhaseValue> = [
  EmployeePhase.READY_FOR_REVIEW,
  EmployeePhase.FAILED,
  EmployeePhase.CANCELED,
  EmployeePhase.TIMED_OUT,
];

/** True when the phase is terminal. Used for restart recovery and reaping. */
export function isTerminalPhase(phase: EmployeePhaseValue): boolean {
  return TERMINAL_PHASES.includes(phase);
}

/** What the employee is willing to execute right now (honest capability). */
export const EmployeeScopeTier = {
  /** Static multi-page HTML/CSS/JS sites. Fully deterministic, no shell out. */
  STATIC_SITE: 'STATIC_SITE',
  /**
   * Web apps requiring a real node/npm build. NOT supported without a sandboxed
   * build runner — requests are rejected, not faked. (Prompts17 Phase 18 blocker)
   */
  REACT_NEXT: 'REACT_NEXT',
  /** Anything outside the supported tier. */
  UNSUPPORTED: 'UNSUPPORTED',
} as const;
export type EmployeeScopeTierValue = (typeof EmployeeScopeTier)[keyof typeof EmployeeScopeTier];

export interface WebsiteTaskInput {
  readonly taskId: string;
  readonly projectId: string;
  readonly clientId: string;
  readonly requestText: string;
}

export interface SiteSpec {
  readonly name: string;
  readonly tagline: string;
  readonly pages: ReadonlyArray<{
    readonly slug: string;
    readonly title: string;
    readonly intro: string;
  }>;
  readonly sections: ReadonlyArray<string>;
  readonly primaryColor: string;
  readonly accentColor: string;
  readonly font: string;
  readonly language: string;
  /** Optional keyword-derived notes surfaced to the client as plan context. */
  readonly notes?: ReadonlyArray<string>;
}

export interface ToolStep {
  readonly toolName: string;
  readonly step: 'ASSEMBLE' | 'BUILD' | 'VALIDATE' | 'PACKAGE';
  readonly detail: string;
}

export interface ExecutionPlan {
  readonly objective: string;
  readonly scopeTier: EmployeeScopeTierValue;
  readonly steps: ReadonlyArray<ToolStep>;
  readonly estimatedFiles: number;
}

export interface ValidationRequirements {
  readonly requiredFiles: ReadonlyArray<string>;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly assertInternalLinks: boolean;
  readonly assertNoLargerThanExpected: boolean;
}

export interface ValidationIssue {
  readonly category:
    'FILE_MISSING' | 'FILE_TOO_LARGE' | 'TOTAL_TOO_LARGE' | 'BAD_LINK' | 'MALFORMED_HTML';
  readonly severity: 'error' | 'warning';
  readonly message: string;
}

export interface ValidationReport {
  readonly structureOk: boolean;
  readonly linksOk: boolean;
  readonly htmlOk: boolean;
  readonly artifactsOk: boolean;
  readonly passed: boolean;
  readonly issues: ReadonlyArray<ValidationIssue>;
  readonly fileCount: number;
  readonly totalBytes: number;
}

export interface ArtifactInfo {
  readonly fileName: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface EmployeeResult {
  readonly phase: EmployeePhaseValue;
  readonly status: EmployeePhaseValue;
  readonly summary: string;
  readonly siteSpec?: SiteSpec;
  readonly plan?: ExecutionPlan;
  readonly validation?: ValidationReport;
  readonly artifact?: ArtifactInfo;
  readonly filesCreated: number;
  readonly bytesWritten: number;
  readonly repairAttempts: number;
  readonly toolCalls: number;
  readonly warnings: ReadonlyArray<string>;
  readonly nextActions: ReadonlyArray<string>;
  readonly durationMs: number;
  readonly error?: { readonly code: string; readonly message: string };
}

export interface EmployeeTaskContext {
  readonly taskId: string;
  readonly projectId: string;
  readonly clientId: string;
}

/** DTO bridged to the Hub over the new runtime endpoint. */
export interface EmployeeRunRequest {
  readonly projectId: string;
  readonly clientId: string;
  readonly requestText: string;
  readonly requestId: string;
  readonly traceId?: string;
}

export interface EmployeeRunResponse {
  readonly taskId: string;
  readonly employee: 'AG-701';
  readonly result: EmployeeResult;
}

export interface EmployeeStatusResponse {
  readonly taskId: string;
  readonly status: EmployeePhaseValue;
  readonly result?: EmployeeResult;
}

export interface EmployeeArtifactResponse {
  readonly taskId: string;
  readonly fileName: string;
  readonly sizeBytes: number;
  readonly contentType: string;
  readonly base64: string;
  readonly sha256?: string;
}
