import type { RequestContext } from './request-context.js';

/**
 * A validated request intended for a specific agent. Reused across agents and
 * pipelines; the payload is deliberately generic and unvalidated until a later
 * sprint enforces per-agent schemas.
 */
export interface AgentRequest<P = unknown> {
  /** Stable agent identifier in the form `AG-NNN`. */
  readonly agentId: string;
  /** Request classification used by routing (filled in a later sprint). */
  readonly type: string;
  /** Typed, opaque payload carried by the request. */
  readonly payload?: P;
  /** Correlation metadata scoping the request. */
  readonly context: RequestContext;
}
