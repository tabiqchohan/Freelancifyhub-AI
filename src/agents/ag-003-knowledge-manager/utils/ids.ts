import { randomUUID } from 'node:crypto';

import type { KnowledgeChunkId, KnowledgeId, KnowledgeVersionId } from '../types/index.js';
import type { IsoTimestamp, TraceId, RequestId } from '../types/index.js';

/** Creates a new knowledge document identifier (`knowledge_<uuid>`). */
export function createKnowledgeId(): KnowledgeId {
  return `knowledge_${randomUUID()}`;
}

/** Creates a new knowledge version identifier (`kver_<uuid>`). */
export function createKnowledgeVersionId(): KnowledgeVersionId {
  return `kver_${randomUUID()}`;
}

/** Creates a new knowledge chunk identifier (`kchunk_<uuid>`). */
export function createChunkId(): KnowledgeChunkId {
  return `kchunk_${randomUUID()}`;
}

/** Creates a new correlation identifier. */
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
