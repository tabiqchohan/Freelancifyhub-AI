import { randomUUID } from 'node:crypto';

import type { IsoTimestamp, RequestId, TraceId } from '../types/index.js';

/** Creates a new correlation identifier (blueprint §23). */
export function createTraceId(): TraceId {
  return `trace_${randomUUID()}`;
}

/** Creates a new request identifier. */
export function createRequestId(): RequestId {
  return `req_${randomUUID()}`;
}

/** Returns the current time as an ISO-8601 string. */
export function nowIso(): IsoTimestamp {
  return new Date().toISOString();
}
