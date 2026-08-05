import type { AgentMetadata } from '../interfaces/index.js';
import type { AgentResponse } from '../interfaces/index.js';
import type { ErrorInfo } from '../types/index.js';
import { ExecutionStatus } from '../types/index.js';
import { nowIso } from '../utils/ids.js';

/** Builder producing an immutable {@link AgentResponse} with metadata. */
export class ResponseBuilder {
  private agentId = '';
  private requestId = '';
  private traceId = '';
  private startedAt = nowIso();
  private attempts = 1;

  withAgentId(agentId: string): this {
    this.agentId = agentId;
    return this;
  }

  withRequestId(requestId: string): this {
    this.requestId = requestId;
    return this;
  }

  withTraceId(traceId: string): this {
    this.traceId = traceId;
    return this;
  }

  withStartedAt(startedAt: string): this {
    this.startedAt = startedAt;
    return this;
  }

  withAttempts(attempts: number): this {
    this.attempts = attempts;
    return this;
  }

  buildMetadata(status: ExecutionStatus): AgentMetadata {
    const completedAt = nowIso();
    const durationMs =
      completedAt >= this.startedAt ? Date.parse(completedAt) - Date.parse(this.startedAt) : 0;

    return {
      agentId: this.agentId,
      requestId: this.requestId,
      traceId: this.traceId,
      startedAt: this.startedAt,
      completedAt,
      durationMs,
      attempts: this.attempts,
      status,
    };
  }

  /** Builds a successful response carrying an optional payload. */
  success<P>(payload?: P): AgentResponse<P> {
    return this.toResponse<P>(ExecutionStatus.Succeeded, payload);
  }

  /** Builds a failed response carrying an error. */
  failure(error: ErrorInfo): AgentResponse {
    return this.toResponse(ExecutionStatus.Failed, undefined, error);
  }

  private toResponse<P>(status: ExecutionStatus, payload?: P, error?: ErrorInfo): AgentResponse<P> {
    return {
      agentId: this.agentId,
      requestId: this.requestId,
      status,
      payload,
      metadata: this.buildMetadata(status),
      error,
    };
  }
}
