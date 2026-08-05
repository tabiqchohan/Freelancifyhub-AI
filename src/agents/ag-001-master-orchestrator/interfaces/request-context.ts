import type { RequestId, IsoTimestamp } from '../types/index.js';
import type { TraceId } from '../types/index.js';

/** Immutable metadata describing a single request entering the orchestrator. */
export interface RequestContext {
  /** Correlation id shared across all involved components (blueprint §23). */
  readonly traceId: TraceId;
  /** Unique identifier of this request/invocation. */
  readonly requestId: RequestId;
  /** ISO-8601 timestamp of when the request was received. */
  readonly receivedAt: IsoTimestamp;
  /** Optional source description (for example the calling gateway). */
  readonly origin?: string;
}
