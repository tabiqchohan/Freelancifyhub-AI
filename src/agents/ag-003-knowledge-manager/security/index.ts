import {
  KnowledgeActorGroup,
  KnowledgeLifecycleState,
  KnowledgePermission,
  KnowledgeSecurityLevel,
} from '../enums/index.js';
import type { KnowledgeNamespace } from '../types/index.js';
import { KnowledgeAccessDeniedError } from '../errors/index.js';

/**
 * Knowledge authorization model. Reuses AG-002's actor pattern concepts
 * adapted for knowledge-specific operations. Fail-closed by design.
 */

/** An actor requesting an operation on knowledge. */
export interface KnowledgeActor {
  readonly group: KnowledgeActorGroup;
  readonly id?: string;
  readonly type?: string;
  readonly role?: string;
  readonly organizationId?: string;
  readonly workspaceId?: string;
  readonly projectIds?: readonly string[];
  readonly securityClearance?: KnowledgeSecurityLevel;
  /** Explicit allow-list of namespaces this actor may touch. */
  readonly namespaces?: readonly KnowledgeNamespace[];
}

/** Target of an access check. */
export interface KnowledgeAccessCheckTarget {
  readonly namespace: KnowledgeNamespace;
  readonly securityLevel: KnowledgeSecurityLevel;
  readonly lifecycle: KnowledgeLifecycleState;
  readonly createdBy?: string;
}

/** Input to a single access decision. */
export interface KnowledgeAccessCheckInput {
  readonly actor: KnowledgeActor;
  readonly permission: KnowledgePermission;
  readonly target: KnowledgeAccessCheckTarget;
}

/** Authorization contract (fail-closed by design). */
export interface KnowledgeAuthorizationPolicy {
  readonly name: string;
  evaluate(input: KnowledgeAccessCheckInput): KnowledgeAuthorizationPolicyResult;
}

export interface KnowledgeAuthorizationPolicyResult {
  readonly allowed: boolean;
  readonly reason?: string;
  readonly code?: string;
}

export interface KnowledgeAuthorizationService {
  readonly name: string;
  authorize(input: KnowledgeAccessCheckInput): KnowledgeAuthorizationDecision;
}

export interface KnowledgeAuthorizationDecision {
  readonly allowed: boolean;
  readonly reason?: string;
  readonly code?: string;
}

/**
 * Knowledge access matrix: permissions per actor group.
 * Fail-closed: missing entries default to denied.
 */
export const KNOWLEDGE_ACCESS_MATRIX: Readonly<
  Record<KnowledgeActorGroup, readonly KnowledgePermission[]>
> = {
  [KnowledgeActorGroup.Orchestrator]: [KnowledgePermission.Read],
  [KnowledgeActorGroup.MemoryManager]: [KnowledgePermission.Read],
  [KnowledgeActorGroup.KnowledgeManager]: [
    KnowledgePermission.Read,
    KnowledgePermission.Create,
    KnowledgePermission.UpdateVersion,
    KnowledgePermission.Archive,
    KnowledgePermission.Restore,
    KnowledgePermission.Expire,
    KnowledgePermission.DeleteErase,
    KnowledgePermission.LifecycleManage,
  ],
  [KnowledgeActorGroup.Client]: [
    KnowledgePermission.Read,
    KnowledgePermission.Create,
    KnowledgePermission.UpdateVersion,
  ],
  [KnowledgeActorGroup.Freelancer]: [
    KnowledgePermission.Read,
    KnowledgePermission.Create,
    KnowledgePermission.UpdateVersion,
  ],
  [KnowledgeActorGroup.Marketplace]: [
    KnowledgePermission.Read,
    KnowledgePermission.Create,
    KnowledgePermission.UpdateVersion,
  ],
  [KnowledgeActorGroup.Marketing]: [KnowledgePermission.Read],
  [KnowledgeActorGroup.Admin]: [
    KnowledgePermission.Read,
    KnowledgePermission.Create,
    KnowledgePermission.UpdateVersion,
    KnowledgePermission.Archive,
    KnowledgePermission.Restore,
    KnowledgePermission.Expire,
    KnowledgePermission.DeleteErase,
    KnowledgePermission.LifecycleManage,
  ],
};

/** Matrix-based permission policy. */
export class KnowledgeMatrixPermissionPolicy implements KnowledgeAuthorizationPolicy {
  readonly name = 'knowledge-matrix-permission-policy';

  evaluate(input: KnowledgeAccessCheckInput): KnowledgeAuthorizationPolicyResult {
    const { actor, permission } = input;
    const granted = KNOWLEDGE_ACCESS_MATRIX[actor.group] ?? [];
    if (!granted.includes(permission)) {
      return {
        allowed: false,
        reason: `Actor group ${actor.group} lacks ${permission} permission`,
        code: 'INSUFFICIENT_PERMISSION',
      };
    }
    return { allowed: true };
  }
}

/** Namespace scope policy — fail-closed on missing namespaces. */
export class KnowledgeNamespaceScopePolicy implements KnowledgeAuthorizationPolicy {
  readonly name = 'knowledge-namespace-scope-policy';

  evaluate(input: KnowledgeAccessCheckInput): KnowledgeAuthorizationPolicyResult {
    const { actor, target } = input;
    const namespaces = actor.namespaces;
    if (namespaces === undefined || namespaces.length === 0) {
      return {
        allowed: false,
        reason: 'Actor has no namespace scope defined',
        code: 'MISSING_SCOPE',
      };
    }
    if (!namespaces.includes(target.namespace)) {
      return {
        allowed: false,
        reason: `Actor scope does not include namespace ${target.namespace}`,
        code: 'SCOPE_VIOLATION',
      };
    }
    return { allowed: true };
  }
}

/** Security level enforcement policy. */
export class KnowledgeSecurityLevelPolicy implements KnowledgeAuthorizationPolicy {
  readonly name = 'knowledge-security-level-policy';

  evaluate(input: KnowledgeAccessCheckInput): KnowledgeAuthorizationPolicyResult {
    const { actor, target } = input;
    const actorClearance = actor.securityClearance ?? KnowledgeSecurityLevel.Internal;
    const targetLevel = target.securityLevel;

    if (
      targetLevel === KnowledgeSecurityLevel.Confidential &&
      actorClearance === KnowledgeSecurityLevel.Internal
    ) {
      return {
        allowed: false,
        reason: `Actor clearance ${actorClearance} insufficient for ${targetLevel} knowledge`,
        code: 'SECURITY_LEVEL_VIOLATION',
      };
    }
    return { allowed: true };
  }
}

/** Lifecycle state access policy — fail-closed on deleted. */
export class KnowledgeLifecycleAccessPolicy implements KnowledgeAuthorizationPolicy {
  readonly name = 'knowledge-lifecycle-access-policy';

  evaluate(input: KnowledgeAccessCheckInput): KnowledgeAuthorizationPolicyResult {
    const { target } = input;
    if (target.lifecycle === KnowledgeLifecycleState.Deleted) {
      return {
        allowed: false,
        reason: 'Deleted knowledge is not accessible',
        code: 'LIFECYCLE_VIOLATION',
      };
    }
    return { allowed: true };
  }
}

/** Owner match policy: restricts create/update-version to the creator. */
export class KnowledgeOwnerPolicy implements KnowledgeAuthorizationPolicy {
  readonly name = 'knowledge-owner-policy';

  evaluate(input: KnowledgeAccessCheckInput): KnowledgeAuthorizationPolicyResult {
    const { actor, target, permission } = input;
    if (
      permission === KnowledgePermission.Read ||
      permission === KnowledgePermission.LifecycleManage
    ) {
      return { allowed: true };
    }
    if (target.createdBy !== undefined && actor.id !== undefined) {
      if (target.createdBy !== actor.id) {
        return {
          allowed: false,
          reason: 'Actor is not the owner of this knowledge',
          code: 'OWNERSHIP_VIOLATION',
        };
      }
    }
    return { allowed: true };
  }
}

/** Composite policy that evaluates all policies in sequence (fail-closed). */
export class CompositeKnowledgeAuthorizationPolicy implements KnowledgeAuthorizationPolicy {
  readonly name = 'composite-knowledge-authorization-policy';

  constructor(private readonly policies: readonly KnowledgeAuthorizationPolicy[]) {}

  evaluate(input: KnowledgeAccessCheckInput): KnowledgeAuthorizationPolicyResult {
    for (const policy of this.policies) {
      const result = policy.evaluate(input);
      if (!result.allowed) {
        return result;
      }
    }
    return { allowed: true };
  }
}

/** Default authorization service. */
export class DefaultKnowledgeAuthorizationService implements KnowledgeAuthorizationService {
  readonly name = 'default-knowledge-authorization-service';

  private readonly compositePolicy: KnowledgeAuthorizationPolicy;

  constructor() {
    this.compositePolicy = new CompositeKnowledgeAuthorizationPolicy([
      new KnowledgeMatrixPermissionPolicy(),
      new KnowledgeNamespaceScopePolicy(),
      new KnowledgeSecurityLevelPolicy(),
      new KnowledgeOwnerPolicy(),
      new KnowledgeLifecycleAccessPolicy(),
    ]);
  }

  authorize(input: KnowledgeAccessCheckInput): KnowledgeAuthorizationDecision {
    if (!input.actor || !input.actor.group) {
      return {
        allowed: false,
        reason: 'Invalid or missing actor context',
        code: 'INVALID_ACTOR_CONTEXT',
      };
    }
    const result = this.compositePolicy.evaluate(input);
    return {
      allowed: result.allowed,
      reason: result.reason,
      code: result.code,
    };
  }
}

/** Creates an authorization service with injected policies (for testing). */
export function createKnowledgeAuthorizationService(
  policies?: readonly KnowledgeAuthorizationPolicy[],
): KnowledgeAuthorizationService {
  class ConfiguredKnowledgeAuthorizationService implements KnowledgeAuthorizationService {
    readonly name = 'configured-knowledge-authorization-service';
    private readonly composite: KnowledgeAuthorizationPolicy;

    constructor(pols: readonly KnowledgeAuthorizationPolicy[]) {
      const effective =
        pols.length > 0
          ? pols
          : [
              new KnowledgeMatrixPermissionPolicy(),
              new KnowledgeNamespaceScopePolicy(),
              new KnowledgeSecurityLevelPolicy(),
              new KnowledgeOwnerPolicy(),
              new KnowledgeLifecycleAccessPolicy(),
            ];
      this.composite = new CompositeKnowledgeAuthorizationPolicy(effective);
    }

    authorize(input: KnowledgeAccessCheckInput): KnowledgeAuthorizationDecision {
      if (!input.actor || !input.actor.group) {
        return {
          allowed: false,
          reason: 'Invalid or missing actor context',
          code: 'INVALID_ACTOR_CONTEXT',
        };
      }
      return this.composite.evaluate(input);
    }
  }
  return new ConfiguredKnowledgeAuthorizationService(policies ?? []);
}

/** Validates an actor context for completeness (fail-closed). */
export function validateKnowledgeActorContext(actor: unknown): asserts actor is KnowledgeActor {
  if (!actor || typeof actor !== 'object') {
    throw new KnowledgeAccessDeniedError('Actor context is missing', {
      code: 'INVALID_ACTOR_CONTEXT',
    });
  }
  const a = actor as Record<string, unknown>;
  if (!a.group || typeof a.group !== 'string') {
    throw new KnowledgeAccessDeniedError('Actor group is required', {
      code: 'INVALID_ACTOR_CONTEXT',
    });
  }
}
