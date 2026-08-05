import type { RequestContext } from '../interfaces/index.js';
import type { IsoTimestamp } from '../types/index.js';
import type { RequestId } from '../types/index.js';
import type { TraceId } from '../types/index.js';
import { createRequestId, createTraceId, nowIso } from '../utils/ids.js';
import { validateWithSchema } from '../utils/schema.js';
import { requestContextSchema } from '../schemas/index.js';

/** Fluent builder producing an immutable {@link RequestContext}. */
export class RequestContextBuilder {
  private traceId: TraceId;
  private requestId: RequestId;
  private receivedAt: IsoTimestamp;
  private origin?: string;

  constructor() {
    this.traceId = createTraceId();
    this.requestId = createRequestId();
    this.receivedAt = nowIso();
  }

  withTraceId(traceId: TraceId): this {
    this.traceId = traceId;
    return this;
  }

  withRequestId(requestId: RequestId): this {
    this.requestId = requestId;
    return this;
  }

  withReceivedAt(receivedAt: IsoTimestamp): this {
    this.receivedAt = receivedAt;
    return this;
  }

  withOrigin(origin: string): this {
    this.origin = origin;
    return this;
  }

  build(): RequestContext {
    return validateWithSchema(requestContextSchema, {
      traceId: this.traceId,
      requestId: this.requestId,
      receivedAt: this.receivedAt,
      origin: this.origin,
    } satisfies RequestContext) as RequestContext;
  }
}
