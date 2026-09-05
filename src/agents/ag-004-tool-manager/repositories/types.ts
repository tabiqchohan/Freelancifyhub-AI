import type { IsoTimestamp, ToolJsonValue, ToolNamespace } from '../types/index.js';
import type { ToolCategory, ToolPermission, ToolSecurityLevel } from '../enums/index.js';

/**
 * Portable, JSON-serializable tool definition record. This is the persisted
 * shape. It deliberately excludes live zod schemas and handler functions
 * (executable JS is never stored as an execution mechanism), and it never
 * contains secrets or credentials.
 */
export interface ToolRecord {
  /** `tool:<name>:v<version>` identity. */
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly category: ToolCategory;
  readonly securityLevel: ToolSecurityLevel;
  /** Permissions in portable form. */
  readonly permissions: readonly ToolPermissionRef[];
  /** Execution policy in portable (JSON-safe) form. */
  readonly executionPolicy: PortableExecutionPolicy;
  readonly enabled: boolean;
  readonly metadata: Readonly<Record<string, ToolJsonValue>>;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export interface ToolPermissionRef {
  readonly permission: ToolPermission;
  readonly scope?: ToolNamespace;
}

export interface PortableRetryPolicy {
  readonly maxRetries: number;
  readonly backoffBaseMs: number;
  readonly backoffMaxMs: number;
}

export interface PortableRateLimit {
  readonly maxPerWindow?: number;
  readonly windowMs?: number;
}

export interface PortableExecutionPolicy {
  readonly timeoutMs: number;
  readonly maxInputBytes: number;
  readonly maxOutputBytes: number;
  readonly retryPolicy: PortableRetryPolicy;
  readonly concurrencyLimit?: number;
  readonly rateLimit?: PortableRateLimit;
  readonly allowedActorGroups?: readonly string[];
  readonly securityLevel: ToolSecurityLevel;
}

/** Filter criteria for listing tools. */
export interface ToolRecordFilter {
  readonly name?: string;
  readonly category?: ToolCategory;
  readonly enabled?: boolean;
  readonly namespace?: ToolNamespace;
}

/** Pagination input for deterministic listing. */
export interface ToolPagination {
  readonly offset: number;
  readonly limit: number;
  readonly sortBy?: 'created_at' | 'updated_at' | 'name';
  readonly sortDirection?: 'asc' | 'desc';
}

/** A page of tool records. */
export interface ToolRecordPage {
  readonly items: readonly ToolRecord[];
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
  readonly hasMore: boolean;
}
