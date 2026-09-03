import { KnowledgeLifecycleState } from '../enums/index.js';
import { KnowledgeLifecycleTransitionError } from '../errors/index.js';
import type { KnowledgeDocument, IsoTimestamp, TraceId } from '../types/index.js';

/**
 * Lifecycle transition contract for knowledge documents.
 * Invalid transitions produce a typed KnowledgeLifecycleTransitionError.
 */
export interface KnowledgeLifecycleContract {
  readonly name: string;
  readonly allowed: Readonly<Record<KnowledgeLifecycleState, readonly KnowledgeLifecycleState[]>>;
  canTransition(from: KnowledgeLifecycleState, to: KnowledgeLifecycleState): boolean;
  transition(from: KnowledgeLifecycleState, to: KnowledgeLifecycleState): KnowledgeLifecycleState;
}

/**
 * Canonical transitions:
 * - Active → Archived | Expired | Deleted
 * - Archived → Active (restore) | Deleted
 * - Expired → Deleted
 * - Deleted → (terminal, no transitions)
 */
const ALLOWED_TRANSITIONS: Readonly<
  Record<KnowledgeLifecycleState, readonly KnowledgeLifecycleState[]>
> = {
  [KnowledgeLifecycleState.Active]: [
    KnowledgeLifecycleState.Archived,
    KnowledgeLifecycleState.Expired,
    KnowledgeLifecycleState.Deleted,
  ],
  [KnowledgeLifecycleState.Archived]: [
    KnowledgeLifecycleState.Active,
    KnowledgeLifecycleState.Deleted,
  ],
  [KnowledgeLifecycleState.Expired]: [KnowledgeLifecycleState.Deleted],
  [KnowledgeLifecycleState.Deleted]: [],
};

/** Deterministic lifecycle implementation. */
export class DefaultKnowledgeLifecycle implements KnowledgeLifecycleContract {
  readonly name = 'default-knowledge-lifecycle';
  readonly allowed = ALLOWED_TRANSITIONS;

  canTransition(from: KnowledgeLifecycleState, to: KnowledgeLifecycleState): boolean {
    return (this.allowed[from] ?? []).includes(to);
  }

  transition(from: KnowledgeLifecycleState, to: KnowledgeLifecycleState): KnowledgeLifecycleState {
    if (!this.canTransition(from, to)) {
      throw new KnowledgeLifecycleTransitionError(
        `Invalid knowledge lifecycle transition ${from} → ${to}`,
        { details: { from, to } },
      );
    }
    return to;
  }
}

/** Shared deterministic lifecycle instance. */
export const knowledgeLifecycle: KnowledgeLifecycleContract = new DefaultKnowledgeLifecycle();

/** Result of a lifecycle transition. */
export interface KnowledgeLifecycleTransitionResult {
  readonly from: KnowledgeLifecycleState;
  readonly to: KnowledgeLifecycleState;
  readonly at: IsoTimestamp;
  readonly traceId: TraceId;
  readonly document: KnowledgeDocument;
}

/**
 * Applies a validated lifecycle transition to a document. Never mutates the
 * input — returns a new document with lifecycle, updatedAt, and traceId updated.
 */
export function transitionKnowledgeDocument(
  document: KnowledgeDocument,
  to: KnowledgeLifecycleState,
  at: IsoTimestamp,
  traceId: TraceId,
  reason: string,
  lifecycle: KnowledgeLifecycleContract = knowledgeLifecycle,
): KnowledgeLifecycleTransitionResult {
  lifecycle.transition(document.lifecycle, to);
  return {
    from: document.lifecycle,
    to,
    at,
    traceId,
    document: {
      ...document,
      lifecycle: to,
      updatedAt: at,
      updatedBy: reason,
      traceId,
    },
  };
}
