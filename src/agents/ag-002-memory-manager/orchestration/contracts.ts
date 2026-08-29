import type { MemoryPriority, MemorySecurityLevel, MemoryType } from '../enums/index.js';
import type { MemoryActor } from '../security/index.js';
import type { MemoryKey, MemoryNamespace, RequestId, TraceId } from '../types/index.js';
import type { MemoryRetrievalResult } from '../retrieval/index.js';

/**
 * Sprint 8 â€” Master Orchestrator integration contracts (prompt Â§2, Â§3, Â§18).
 *
 * The narrow memory-capability boundary that AG-001 may depend on. AG-001 never
 * touches AG-002 repositories, storage, or internal services. Every entry point
 * requires an explicit actor (fail-closed for protected memory) and preserves
 * AG-001 correlation identifiers verbatim.
 */

/** Status of an orchestration memory-context request (prompt Â§6). */
export enum MemoryContextStatus {
  /** Memory integration is disabled by configuration. */
  Disabled = 'MEMORY_DISABLED',
  /** Memory is enabled and produced context. */
  Available = 'MEMORY_AVAILABLE',
  /** Memory is enabled but returned no matching/authorized records. */
  Empty = 'MEMORY_EMPTY',
  /** Memory integration is unavailable (missing dependency / not operational). */
  Unavailable = 'MEMORY_UNAVAILABLE',
  /** Access/authorization was denied for the requested actor scope. */
  SecurityDenied = 'MEMORY_SECURITY_DENIED',
  /** The retrieval or context step exceeded its bounded time budget. */
  Timeout = 'MEMORY_TIMEOUT',
  /** The integration returned an invalid/unsupported response shape. */
  InvalidResponse = 'MEMORY_INVALID_RESPONSE',
}

/**
 * A single, redacted memory context section delivered to AG-001. Mirrors the
 * AG-002 {@link ContextSection} but never leaks repository internals or raw
 * sensitive metadata.
 */
export interface OrchestrationContextSection {
  readonly type: MemoryType;
  readonly priority: MemoryPriority;
  readonly recordCount: number;
  readonly tokenEstimate: number;
  readonly truncated: boolean;
  readonly sections?: never;
}

/**
 * A single redacted memory record emitted into the orchestration context.
 * Only safe, bounded fields reach AG-001.
 */
export interface OrchestrationMemoryRecord {
  readonly id: string;
  readonly namespace: MemoryNamespace;
  readonly key: MemoryKey;
  readonly type: MemoryType;
  readonly priority: MemoryPriority;
  readonly securityLevel: MemorySecurityLevel;
  readonly snippet: string;
  readonly tokenEstimate: number;
  readonly version: number;
}

/** A deterministic context section delivered to AG-001. */
export interface OrchestrationMemorySection {
  readonly type: MemoryType;
  readonly priority: MemoryPriority;
  readonly records: readonly OrchestrationMemoryRecord[];
  readonly tokenEstimate: number;
  readonly truncated: boolean;
}

/** Safe, deterministic context result for AG-001 (prompt Â§18). */
export interface MemoryContextResult {
  readonly enabled: boolean;
  readonly status: MemoryContextStatus;
  readonly sections: readonly OrchestrationMemorySection[];
  readonly recordCount: number;
  readonly tokenCount: number;
  readonly truncated: boolean;
  readonly traceId: TraceId;
  readonly requestId?: RequestId;
  readonly executionId?: string;
  readonly correlationId?: string;
  readonly warnings: readonly string[];
}

/**
 * A request for orchestration-time memory context. Fields use AG-002 idioms
 * directly so AG-001 mapping is a thin translation layer, never a second
 * retrieval/assembly engine (prompt Â§3, Â§10).
 */
export interface OrchestrationMemoryRequest {
  /** The acting user/agent. Access is fail-closed without a valid actor. */
  readonly actor: MemoryActor;
  /** AG-001 request id, preserved verbatim for correlation. */
  readonly requestId?: RequestId;
  /** AG-001 execution id, preserved verbatim for correlation. */
  readonly executionId?: string;
  /** AG-001 correlation id, preserved verbatim for correlation. */
  readonly correlationId?: string;
  /** Namespace the retrieval is scoped to. */
  readonly namespace: MemoryNamespace;
  /** Optional raw query string used for relevance scoring. */
  readonly query?: string;
  /** Optional memory-type filter. */
  readonly types?: readonly MemoryType[];
  /** Optional priority filter. */
  readonly priorities?: readonly MemoryPriority[];
  /** Optional token budget for the assembled context. */
  readonly contextBudgetTokens?: number;
  /** Optional max context sections override. */
  readonly maxSections?: number;
  /** Optional max records per section override. */
  readonly maxRecordsPerSection?: number;
  /** Optional snippet length override. */
  readonly snippetLength?: number;
  /** Optional trace id (defaults to generated). */
  readonly traceId?: string;
  /** A signal that the orchestration request has been cancelled. */
  readonly isCancelled?: () => boolean;
}

/** Input to a single memory-context fetch attempt (prompt Â§6). */
export interface MemoryFetchAttemptInput {
  readonly request: OrchestrationMemoryRequest;
  readonly timeoutMs: number;
}

/** A resolved, bounded context fetch (the integration service internal step). */
export interface MemoryFetchResult {
  readonly status: MemoryContextStatus;
  readonly results: readonly MemoryRetrievalResult[];
  readonly recordCount: number;
  readonly warnings: readonly string[];
  readonly timedOut: boolean;
  readonly truncation: boolean;
}

/** A resolved context assembly step (prompt Â§6). */
export interface MemoryContextAssemblyResult {
  readonly sections: readonly OrchestrationMemorySection[];
  readonly recordCount: number;
  readonly tokenCount: number;
  readonly truncated: boolean;
}

/** Write-back categories for orchestration-triggered memory (prompt Â§11). */
export enum MemoryWriteBackPolicy {
  /** No automatic persistence of requests or responses. */
  None = 'NONE',
  /** Persist only when explicitly requested by the caller. */
  Explicit = 'EXPLICIT',
  /** Persist on specific, policy-approved events. */
  EventBased = 'EVENT_BASED',
  /** Persist selectively under bounded, authorized, auditable conditions. */
  Selective = 'SELECTIVE',
}

/** A snapshot of the integration's declared + runtime capability surface. */
export interface OrchestrationMemoryCapabilities {
  readonly enabled: boolean;
  readonly available: boolean;
  readonly retrievalAvailable: boolean;
  readonly contextIntegrationAvailable: boolean;
  readonly eventLogAvailable: boolean;
  readonly storageAvailable: boolean;
  readonly writeBack: MemoryWriteBackPolicy;
}
