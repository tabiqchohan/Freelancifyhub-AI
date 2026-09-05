import type { z } from 'zod';

import type {
  ToolActorGroup,
  ToolCategory,
  ToolErrorClass,
  ToolPermission,
  ToolResultStatus,
  ToolSecurityLevel,
} from '../enums/index.js';

/** ISO-8601 timestamp string. */
export type IsoTimestamp = string;

/** Trace (correlation) identifier. */
export type TraceId = string;

/** Request identifier. */
export type RequestId = string;

/** Namespace/scope for tool isolation. */
export type ToolNamespace = string;

/** JSON-compatible primitive. */
export type ToolJsonPrimitive = string | number | boolean | null;

/** Recursive JSON-compatible value. */
export type ToolJsonValue =
  ToolJsonPrimitive | readonly ToolJsonValue[] | { readonly [key: string]: ToolJsonValue };

/** A Zod schema describing tool input/output. */
export type ToolSchema = z.ZodType<unknown>;

/** Free-form metadata attached to a tool (sanitized before events/logs). */
export type ToolMetadata = Readonly<Record<string, ToolJsonValue>>;

/** A reference to a permission required to execute a tool. */
export interface ToolPermissionRef {
  readonly permission: ToolPermission;
  readonly scope?: ToolNamespace;
}

/** Retry policy for a tool execution. */
export interface ToolRetryPolicy {
  /** Max retry attempts (0 = no retries). */
  readonly maxRetries: number;
  /** Base delay between retries in ms. */
  readonly backoffBaseMs: number;
  /** Max delay between retries in ms. */
  readonly backoffMaxMs: number;
}

/** Rate-limit abstraction (no distributed enforcement in this sprint). */
export interface ToolRateLimit {
  /** Ops-per-window allowance; undefined = unbounded (advisory). */
  readonly maxPerWindow?: number;
  /** Window length in ms. */
  readonly windowMs?: number;
}

/** Execution policy attached to a tool definition. */
export interface ToolExecutionPolicy {
  /** Hard execution timeout in ms. */
  readonly timeoutMs: number;
  /** Max input bytes accepted. */
  readonly maxInputBytes: number;
  /** Max output bytes accepted. */
  readonly maxOutputBytes: number;
  /** Retry policy (bounded, configurable). */
  readonly retryPolicy: ToolRetryPolicy;
  /** Concurrency limit (advisory in-process). */
  readonly concurrencyLimit?: number;
  /** Rate-limit abstraction (advisory). */
  readonly rateLimit?: ToolRateLimit;
  /** Actor groups allowed to execute. */
  readonly allowedActorGroups?: readonly ToolActorGroup[];
  /** Required security level. */
  readonly securityLevel: ToolSecurityLevel;
}

/** The core, immutable tool definition. */
export interface ToolDefinition {
  /** Canonical identity: `tool:<name>:v<version>` (normalized, safe). */
  readonly id: string;
  /** Normalized tool name. */
  readonly name: string;
  /** Human-readable description. */
  readonly description: string;
  /** Semantic version string (e.g. "1.0.0"). */
  readonly version: string;
  /** Tool category. */
  readonly category: ToolCategory;
  /** Input schema (zod). */
  readonly inputSchema: ToolSchema;
  /** Output schema (zod). */
  readonly outputSchema: ToolSchema;
  /** Permissions required to execute. */
  readonly permissions: readonly ToolPermissionRef[];
  /** Security classification. */
  readonly securityLevel: ToolSecurityLevel;
  /** Execution policy. */
  readonly executionPolicy: ToolExecutionPolicy;
  /** Enabled/disabled state. */
  readonly enabled: boolean;
  /** Free-form metadata (sanitized). */
  readonly metadata: ToolMetadata;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

/** An actor requesting a tool operation. */
export interface ToolActor {
  readonly group: ToolActorGroup;
  readonly id?: string;
  readonly type?: string;
  readonly role?: string;
  readonly organizationId?: string;
  readonly workspaceId?: string;
  readonly projectIds?: readonly string[];
  readonly securityClearance?: ToolSecurityLevel;
  readonly namespaces?: readonly ToolNamespace[];
}

/** Execution-scoped context passed to the executor. */
export interface ToolExecutionContext {
  readonly actor: ToolActor;
  readonly requestId?: RequestId;
  readonly traceId?: TraceId;
  readonly correlationId?: string;
  readonly namespace: ToolNamespace;
  readonly agentId?: string;
  readonly permissions?: readonly string[];
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/** A normalized, sanitized tool result. */
export interface ToolResult {
  readonly toolId: string;
  readonly toolName: string;
  readonly toolVersion: string;
  readonly executionId: string;
  readonly durationMs: number;
  readonly status: ToolResultStatus;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly output?: ToolJsonValue;
  /** Number of attempts made (including retries). */
  readonly attempts?: number;
}

/** A registered tool execution handler. */
export interface ToolHandler {
  readonly name: string;
  /**
   * Executes the tool. `input` is the validated input. Must never perform
   * arbitrary code execution, shell execution, or unrestricted I/O unless
   * explicitly designed and authorized to do so.
   */
  invoke(input: unknown, context: ToolExecutionContext): Promise<unknown> | unknown;
}

/** A tool that can be registered in the registry. */
export interface ToolSpecification {
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly category: ToolCategory;
  readonly inputSchema: ToolSchema;
  readonly outputSchema: ToolSchema;
  readonly handler: ToolHandler;
  readonly permissions?: readonly ToolPermissionRef[];
  readonly securityLevel?: ToolSecurityLevel;
  readonly executionPolicy?: Partial<ToolExecutionPolicy>;
  readonly metadata?: ToolMetadata;
}

/** Deterministic result of classifying an error for retry policy. */
export interface ToolErrorClassification {
  readonly errorClass: ToolErrorClass;
  readonly retryable: boolean;
}
