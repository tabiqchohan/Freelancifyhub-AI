/**
 * Sprint 26 — AIOS request context.
 *
 * The AIOS request context is created by the first pipeline phases
 * (VALIDATE → CREATE_REQUEST_CONTEXT → DETECT_INTENT → ROUTE). Intent is
 * classified by AG-001's rule-based classifier and the execution target is
 * derived from AG-001's own intent registry data (category + supported agents),
 * never from a second routing table.
 */

import { IntentCategory } from '../agents/ag-001-master-orchestrator/intent/index.js';
import type {
  IntentResult,
  IntentClassifier,
  UserRole,
} from '../agents/ag-001-master-orchestrator/intent/index.js';
import { AiosError, AiosErrorCode } from './errors.js';
import type { AiosActor, AiosExecutionTarget, AiosInput, AiosRouteInfo } from './types.js';

export const AIOS_GATEWAY_NAME = 'ai-operating-system';
export const AIOS_GATEWAY_VERSION = '1.0.0';

/** Team agent-id prefixes owned by each AI team (AG-001 catalog). */
const TEAM_PREFIX: ReadonlyArray<{
  readonly prefix: string;
  readonly kind: AiosExecutionTarget['kind'];
}> = [
  { prefix: 'AG-5', kind: 'admin' },
  { prefix: 'AG-1', kind: 'client' },
  { prefix: 'AG-2', kind: 'freelancer' },
  { prefix: 'AG-3', kind: 'marketplace' },
  { prefix: 'AG-4', kind: 'marketing' },
];

/**
 * Derives the AIOS execution target from AG-001 registry data. Intents whose
 * category is Help/Knowledge/System (platform-level, per the intent registry)
 * always run through the orchestrator tail; everything else is owned by the
 * team of the intent's first supported agent id.
 */
export function deriveExecutionTarget(intent: IntentResult): AiosExecutionTarget {
  const definition = intent.primary.intent;
  if (
    definition.category === IntentCategory.Help ||
    definition.category === IntentCategory.Knowledge ||
    definition.category === IntentCategory.System
  ) {
    return { kind: 'orchestrator' };
  }
  for (const agentId of definition.supportedAgents) {
    for (const { prefix, kind } of TEAM_PREFIX) {
      if (agentId.startsWith(prefix)) {
        return { kind };
      }
    }
  }
  return { kind: 'orchestrator' };
}

/** Builds the route info surfaced on the response (from AG-001 data). */
export function routeInfo(intent: IntentResult, target: AiosExecutionTarget): AiosRouteInfo {
  return {
    intentId: intent.primary.intent.id,
    intentCategory: intent.primary.intent.category,
    supportedAgents: [...intent.primary.intent.supportedAgents],
    confidence: intent.confidence,
    target,
  };
}

/** A fully materialised AIOS request context (produced before dispatch). */
export interface RequestContext {
  readonly requestId: string;
  readonly traceId: string;
  readonly actor: AiosActor;
  readonly input: AiosInput;
  readonly receivedAt: string;
  readonly origin: string;
  readonly intent: IntentResult;
  readonly route: AiosRouteInfo;
  readonly target: AiosExecutionTarget;
  readonly timeoutMs: number;
  readonly idempotencyKey?: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

/** Validates the actor envelope (fail-closed on missing identity). */
export function validateAiosActor(actor: AiosActor): void {
  if (typeof actor.actorId !== 'string' || actor.actorId.trim().length === 0) {
    throw new AiosError(AiosErrorCode.InvalidInput, 'actor.actorId is required');
  }
  if (typeof actor.role !== 'string' || actor.role.trim().length === 0) {
    throw new AiosError(AiosErrorCode.InvalidInput, 'actor.role is required');
  }
  if (!Array.isArray(actor.namespaces)) {
    throw new AiosError(AiosErrorCode.InvalidInput, 'actor.namespaces must be an array');
  }
}

export interface CreateRequestContextOptions {
  readonly requestId: string;
  readonly traceId: string;
  readonly actor: AiosActor;
  readonly input: AiosInput;
  readonly classifier: IntentClassifier;
  readonly timeoutMs: number;
  readonly idempotencyKey?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly now?: () => Date;
}

/**
 * Creates the AIOS request context and classifies the intent through AG-001.
 * Throws {@link AiosError} when no intent is reliably detected (fail-closed:
 * an unknown request is never silently routed to an arbitrary agent).
 */
export function createRequestContext(options: CreateRequestContextOptions): RequestContext {
  validateAiosActor(options.actor);

  const receivedAt = (options.now?.() ?? new Date()).toISOString();
  const intent = options.classifier.classify(options.input.text, {
    role: options.actor.role as UserRole,
    requestId: options.requestId,
  });

  if (intent.primary.intent.id === 'unknown') {
    throw new AiosError(AiosErrorCode.UnknownIntent, 'Unable to detect a reliable intent', {
      requestId: options.requestId,
      details: { confidence: intent.confidence, fallbackReason: intent.fallbackReason },
    });
  }

  const target = deriveExecutionTarget(intent);

  return {
    requestId: options.requestId,
    traceId: options.traceId,
    actor: options.actor,
    input: options.input,
    receivedAt,
    origin: AIOS_GATEWAY_NAME,
    intent,
    route: routeInfo(intent, target),
    target,
    timeoutMs: options.timeoutMs,
    idempotencyKey: options.idempotencyKey,
    metadata: options.metadata ?? {},
  };
}
