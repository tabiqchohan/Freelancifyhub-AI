/**
 * Sprint 26 — AIOS execution context.
 *
 * The execution context is created by the pipeline at the EXECUTE phase. It
 * carries the deadline, a cooperative cancellation signal (propagated to the
 * owning team service or the orchestrator tail) and the planned execution
 * record used for aggregation and status work.
 */

import type { RequestContext } from './request-context.js';
import type { AiosExecutionDetail } from './types.js';
import { anyAbortSignal } from '../lib/abort.js';

/** Per-request knob keys consumed only by the AIOS boundary. */
export const KNOB_DELAY_MS = 'aios.delayMs';
export const KNOB_PROBE = 'aiosProbe';

/** The deterministic execution plan selected by the PLAN phase. */
export interface AiosPlan {
  readonly target: string;
  readonly agents: readonly string[];
  readonly steps: readonly string[];
}

/** Cooperative cancellation handle propagated to tail executions. */
export interface AiosCancellation {
  readonly requested: boolean;
  readonly signal: AbortSignal;
}

/** A single, live execution inside the AIOS service. */
export interface ExecutionContext {
  readonly requestId: string;
  readonly traceId: string;
  readonly target: RequestContext['target'];
  readonly intentId: string;
  readonly timeoutMs: number;
  readonly deadlineAt: number;
  readonly startedAtMs: number;
  readonly controller: AbortController;
  readonly cancellation: AiosCancellation;
  readonly plan: AiosPlan;
  readonly metadata: Readonly<Record<string, unknown>>;
  output?: AiosExecutionDetail;
}

export interface CreateExecutionContextOptions {
  readonly requestId: string;
  readonly traceId: string;
  readonly target: RequestContext['target'];
  readonly intentId: string;
  readonly timeoutMs: number;
  readonly plan: AiosPlan;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly now?: () => Date;
  /**
   * Prompts15 Phase 2 — the transport signal (caller disconnected). When it
   * aborts, `controller` aborts exactly as an explicit `/api/ai/cancel` would,
   * so every downstream consumer observes one cancellation semantics.
   */
  readonly signal?: AbortSignal;
}

/** Builds an {@link ExecutionContext} for the EXECUTE phase. */
export function createExecutionContext(options: CreateExecutionContextOptions): ExecutionContext {
  const controller = new AbortController();
  const startedAtMs = Date.now();

  // Prompts15 Phase 2/4 — cancellation is the union of the explicit AIOS cancel
  // controller and the transport signal. `service.cancel()` still aborts the
  // controller; a hung-up caller aborts the same composite, so a provider fetch
  // can never outlive the request that started it.
  const signal =
    options.signal === undefined
      ? controller.signal
      : (anyAbortSignal([controller.signal, options.signal]) ?? controller.signal);

  if (options.signal !== undefined && options.signal.aborted) {
    controller.abort();
  }

  return {
    requestId: options.requestId,
    traceId: options.traceId,
    target: options.target,
    intentId: options.intentId,
    timeoutMs: options.timeoutMs,
    deadlineAt: startedAtMs + options.timeoutMs,
    startedAtMs,
    controller,
    cancellation: {
      // Getters (not a snapshot) so `requested` reflects a disconnect that lands
      // mid-execution: downstream tails check it after their work returns and
      // must still see the cancellation.
      get requested(): boolean {
        return signal.aborted;
      },
      signal,
    },
    plan: options.plan,
    metadata: options.metadata,
  };
}

/**
 * Builds the deterministic execution plan selected by the PLAN phase.
 *
 * The plan is derived from AG-001's intent data — never from a second AIOS
 * routing table — so the agents come from the classified intent's own
 * supported-agent registry and the steps are the stable AIOS vocabulary below.
 */
export const AIOS_PLAN_STEPS: readonly string[] = [
  'validate',
  'detect-intent',
  'build-context',
  'authorize',
  'route',
  'plan',
  'execute',
  'aggregate',
  'safety-check',
  'persist-events',
  'update-metrics',
  'finalize-response',
];

export function createExactAiosPlan(ctx: RequestContext): AiosPlan {
  return {
    target: ctx.target.kind,
    agents: [...ctx.intent.primary.intent.supportedAgents],
    steps: [...AIOS_PLAN_STEPS],
  };
}
