import type { EmployeePhaseValue, EmployeeResult } from '../types.js';

/**
 * Prompts19 Phase 2 — durable record of one AI Employee task.
 *
 * The Hub keeps the authoritative product/audit trail; this record is the
 * AIOS-side durable state so task status and artifact metadata survive a
 * process restart. It deliberately stores only the bounded {@link EmployeeResult}
 * DTO plus identifiers — never secrets, credentials or raw host paths beyond the
 * task's own workspace artifact path.
 */
export interface EmployeeTaskRecord {
  readonly taskId: string;
  readonly projectId: string;
  readonly clientId: string;
  readonly requestText: string;
  readonly requestId: string;
  readonly traceId: string;
  readonly phase: EmployeePhaseValue;
  readonly result: EmployeeResult;
  readonly artifactFileName?: string;
  readonly artifactSha256?: string;
  readonly artifactPath?: string;
  readonly startedAt: number;
  readonly completedAt?: number;
  readonly updatedAt: number;
  readonly expiresAt: number;
}

/** Artifact bytes plus their integrity metadata. */
export interface EmployeeArtifactBytes {
  readonly fileName: string;
  readonly sha256: string;
  readonly bytes: Buffer;
}
