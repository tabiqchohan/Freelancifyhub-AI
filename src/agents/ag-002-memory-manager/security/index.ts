import {
  MemoryActorGroup,
  MemoryLifecycleState,
  MemoryOwnerKind,
  MemoryPermission,
  MemorySecurityLevel,
  MemoryType,
} from '../enums/index.js';
import type { MemoryNamespace } from '../types/index.js';
import { MemoryAccessDeniedError } from '../errors/index.js';

/**
 * Memory access control foundation (spec §7, prompt §7). Implements the
 * authorization contract only — no authentication, no identity provider, no
 * user-account integration in this sprint.
 */

/** An actor requesting an operation on memory. */
export interface MemoryActor {
  /** Agent group from the access matrix (spec §7). */
  readonly group: MemoryActorGroup;
  /** Optional stable identity (future identity integration). */
  readonly id?: string;
  /** Human-readable actor type for logging. */
  readonly type?: string;
  /** Actor's role within their scope (e.g., 'client', 'freelancer', 'admin'). */
  readonly role?: string;
  /** Actor's organization ID if applicable. */
  readonly organizationId?: string;
  /** Actor's workspace ID if applicable. */
  readonly workspaceId?: string;
  /** Actor's project IDs if applicable. */
  readonly projectIds?: readonly string[];
  /** Actor's security clearance level. */
  readonly securityClearance?: MemorySecurityLevel;
  /**
   * Explicit allow-list of namespaces this actor may touch. Fail-closed: an
   * actor without a matching entry is denied 100% (spec §7, AC-MEM-2).
   */
  readonly namespaces?: readonly MemoryNamespace[];
}

/** The memory target an access decision is made against. */
export interface MemoryAccessCheckTarget {
  readonly namespace: MemoryNamespace;
  readonly type: MemoryType;
  readonly securityLevel: MemorySecurityLevel;
  readonly lifecycle: MemoryLifecycleState;
  readonly owner?: {
    readonly kind: MemoryOwnerKind;
    readonly id: string;
  };
}

/** Input to a single access decision. */
export interface MemoryAccessCheckInput {
  readonly actor: MemoryActor;
  readonly permission: MemoryPermission;
  readonly target: MemoryAccessCheckTarget;
}

/** Authorization contract (fail-closed by design). */
export interface MemoryAccessPolicy {
  readonly name: string;
  can(input: MemoryAccessCheckInput): boolean;
}

/**
 * Authorization service — the entry point for all access decisions.
 * Receives an already-resolved actor context (no authentication).
 */
export interface AuthorizationService {
  readonly name: string;
  authorize(input: MemoryAccessCheckInput): AuthorizationDecision;
}

/** Result of an authorization decision. */
export interface AuthorizationDecision {
  readonly allowed: boolean;
  readonly reason?: string;
  readonly code?: string;
}

/**
 * The architecture access matrix (spec §7): permissions per agent group ×
 * memory type. `(own)`/`(role)` scope modifiers are represented by the actor's
 * namespace allow-list, not by the matrix. User-memory `W*` grants for
 * AG-002/Admin are consent/retention writes only.
 */
export const MEMORY_ACCESS_MATRIX: Readonly<
  Record<MemoryActorGroup, Readonly<Record<MemoryType, readonly MemoryPermission[]>>>
> = {
  [MemoryActorGroup.Orchestrator]: {
    [MemoryType.ShortTerm]: [
      MemoryPermission.Read,
      MemoryPermission.Write,
      MemoryPermission.Update,
    ],
    [MemoryType.Conversation]: [MemoryPermission.Read],
    [MemoryType.User]: [MemoryPermission.Read],
    [MemoryType.Project]: [MemoryPermission.Read],
    [MemoryType.Workspace]: [MemoryPermission.Read],
    [MemoryType.Organization]: [MemoryPermission.Read],
    [MemoryType.KnowledgeReference]: [MemoryPermission.Read],
    [MemoryType.Temporary]: [MemoryPermission.Read],
    [MemoryType.Session]: [MemoryPermission.Read, MemoryPermission.Write, MemoryPermission.Update],
    [MemoryType.LongTerm]: [MemoryPermission.Read],
    [MemoryType.Archived]: [MemoryPermission.Read],
  },
  [MemoryActorGroup.MemoryManager]: {
    [MemoryType.ShortTerm]: [
      MemoryPermission.Read,
      MemoryPermission.Write,
      MemoryPermission.Update,
      MemoryPermission.Delete,
    ],
    [MemoryType.Conversation]: [
      MemoryPermission.Read,
      MemoryPermission.Write,
      MemoryPermission.Update,
      MemoryPermission.Delete,
    ],
    [MemoryType.User]: [MemoryPermission.Write],
    [MemoryType.Project]: [MemoryPermission.Write],
    [MemoryType.Workspace]: [
      MemoryPermission.Read,
      MemoryPermission.Write,
      MemoryPermission.Update,
      MemoryPermission.Delete,
    ],
    [MemoryType.Organization]: [
      MemoryPermission.Read,
      MemoryPermission.Write,
      MemoryPermission.Update,
      MemoryPermission.Delete,
    ],
    [MemoryType.KnowledgeReference]: [MemoryPermission.Read, MemoryPermission.Write],
    [MemoryType.Temporary]: [
      MemoryPermission.Read,
      MemoryPermission.Write,
      MemoryPermission.Update,
      MemoryPermission.Delete,
    ],
    [MemoryType.Session]: [MemoryPermission.Read],
    [MemoryType.LongTerm]: [
      MemoryPermission.Read,
      MemoryPermission.Write,
      MemoryPermission.Update,
      MemoryPermission.Delete,
    ],
    [MemoryType.Archived]: [
      MemoryPermission.Read,
      MemoryPermission.Write,
      MemoryPermission.Update,
      MemoryPermission.Delete,
    ],
  },
  [MemoryActorGroup.Client]: {
    [MemoryType.ShortTerm]: [
      MemoryPermission.Read,
      MemoryPermission.Write,
      MemoryPermission.Update,
    ],
    [MemoryType.Conversation]: [
      MemoryPermission.Read,
      MemoryPermission.Write,
      MemoryPermission.Update,
    ],
    [MemoryType.User]: [MemoryPermission.Read, MemoryPermission.Write, MemoryPermission.Update],
    [MemoryType.Project]: [MemoryPermission.Read, MemoryPermission.Write, MemoryPermission.Update],
    [MemoryType.Workspace]: [MemoryPermission.Read],
    [MemoryType.Organization]: [MemoryPermission.Read],
    [MemoryType.KnowledgeReference]: [MemoryPermission.Read],
    [MemoryType.Temporary]: [
      MemoryPermission.Read,
      MemoryPermission.Write,
      MemoryPermission.Update,
    ],
    [MemoryType.Session]: [MemoryPermission.Read],
    [MemoryType.LongTerm]: [MemoryPermission.Write],
    [MemoryType.Archived]: [MemoryPermission.Read],
  },
  [MemoryActorGroup.Freelancer]: {
    [MemoryType.ShortTerm]: [
      MemoryPermission.Read,
      MemoryPermission.Write,
      MemoryPermission.Update,
    ],
    [MemoryType.Conversation]: [
      MemoryPermission.Read,
      MemoryPermission.Write,
      MemoryPermission.Update,
    ],
    [MemoryType.User]: [MemoryPermission.Read, MemoryPermission.Write, MemoryPermission.Update],
    [MemoryType.Project]: [MemoryPermission.Read, MemoryPermission.Write, MemoryPermission.Update],
    [MemoryType.Workspace]: [MemoryPermission.Read],
    [MemoryType.Organization]: [MemoryPermission.Read],
    [MemoryType.KnowledgeReference]: [MemoryPermission.Read],
    [MemoryType.Temporary]: [
      MemoryPermission.Read,
      MemoryPermission.Write,
      MemoryPermission.Update,
    ],
    [MemoryType.Session]: [MemoryPermission.Read],
    [MemoryType.LongTerm]: [MemoryPermission.Write],
    [MemoryType.Archived]: [MemoryPermission.Read],
  },
  [MemoryActorGroup.Marketplace]: {
    [MemoryType.ShortTerm]: [MemoryPermission.Read],
    [MemoryType.Conversation]: [MemoryPermission.Read],
    [MemoryType.User]: [MemoryPermission.Read],
    [MemoryType.Project]: [MemoryPermission.Read, MemoryPermission.Write, MemoryPermission.Update],
    [MemoryType.Workspace]: [MemoryPermission.Read],
    [MemoryType.Organization]: [MemoryPermission.Read],
    [MemoryType.KnowledgeReference]: [MemoryPermission.Read, MemoryPermission.Write],
    [MemoryType.Temporary]: [
      MemoryPermission.Read,
      MemoryPermission.Write,
      MemoryPermission.Update,
    ],
    [MemoryType.Session]: [MemoryPermission.Read],
    [MemoryType.LongTerm]: [MemoryPermission.Write],
    [MemoryType.Archived]: [MemoryPermission.Read],
  },
  [MemoryActorGroup.Marketing]: {
    [MemoryType.ShortTerm]: [
      MemoryPermission.Read,
      MemoryPermission.Write,
      MemoryPermission.Update,
    ],
    [MemoryType.Conversation]: [MemoryPermission.Read],
    [MemoryType.User]: [MemoryPermission.Read],
    [MemoryType.Project]: [MemoryPermission.Read],
    [MemoryType.Workspace]: [
      MemoryPermission.Read,
      MemoryPermission.Write,
      MemoryPermission.Update,
    ],
    [MemoryType.Organization]: [MemoryPermission.Read],
    [MemoryType.KnowledgeReference]: [MemoryPermission.Read],
    [MemoryType.Temporary]: [
      MemoryPermission.Read,
      MemoryPermission.Write,
      MemoryPermission.Update,
    ],
    [MemoryType.Session]: [MemoryPermission.Read],
    [MemoryType.LongTerm]: [MemoryPermission.Read],
    [MemoryType.Archived]: [MemoryPermission.Read],
  },
  [MemoryActorGroup.Admin]: {
    [MemoryType.ShortTerm]: [
      MemoryPermission.Read,
      MemoryPermission.Write,
      MemoryPermission.Update,
    ],
    [MemoryType.Conversation]: [MemoryPermission.Read],
    [MemoryType.User]: [MemoryPermission.Write],
    [MemoryType.Project]: [MemoryPermission.Read],
    [MemoryType.Workspace]: [
      MemoryPermission.Read,
      MemoryPermission.Write,
      MemoryPermission.Update,
      MemoryPermission.Delete,
    ],
    [MemoryType.Organization]: [
      MemoryPermission.Read,
      MemoryPermission.Write,
      MemoryPermission.Update,
      MemoryPermission.Delete,
    ],
    [MemoryType.KnowledgeReference]: [
      MemoryPermission.Read,
      MemoryPermission.Write,
      MemoryPermission.Update,
      MemoryPermission.Delete,
    ],
    [MemoryType.Temporary]: [
      MemoryPermission.Read,
      MemoryPermission.Write,
      MemoryPermission.Update,
    ],
    [MemoryType.Session]: [MemoryPermission.Read],
    [MemoryType.LongTerm]: [
      MemoryPermission.Read,
      MemoryPermission.Write,
      MemoryPermission.Update,
      MemoryPermission.Delete,
    ],
    [MemoryType.Archived]: [
      MemoryPermission.Read,
      MemoryPermission.Write,
      MemoryPermission.Update,
      MemoryPermission.Delete,
    ],
  },
};

/** Deterministic matrix-based policy. Fail-closed on both matrix and scope. */
export class MatrixMemoryAccessPolicy implements MemoryAccessPolicy {
  readonly name = 'matrix-memory-access-policy';

  can(input: MemoryAccessCheckInput): boolean {
    const { actor, permission, target } = input;

    if (!this.matrixGrants(actor.group, target.type, permission)) {
      return false;
    }

    return this.actorHasScope(actor, target.namespace);
  }

  private matrixGrants(
    group: MemoryActorGroup,
    type: MemoryType,
    permission: MemoryPermission,
  ): boolean {
    return (MEMORY_ACCESS_MATRIX[group]?.[type] ?? []).includes(permission);
  }

  private actorHasScope(actor: MemoryActor, namespace: MemoryNamespace): boolean {
    const namespaces = actor.namespaces;
    if (namespaces === undefined || namespaces.length === 0) {
      return false;
    }
    return namespaces.includes(namespace);
  }
}

/** Whether a security level requires audit + encryption controls (AC-MEM-9). */
export function isConfidentialSecurityLevel(level: MemorySecurityLevel): boolean {
  return level === MemorySecurityLevel.Confidential;
}

/** Whether a memory type is classified confidential (spec §4). */
export function isConfidentialType(type: MemoryType): boolean {
  switch (type) {
    case MemoryType.ShortTerm:
    case MemoryType.Workspace:
    case MemoryType.KnowledgeReference:
    case MemoryType.Temporary:
      return false;
    case MemoryType.Conversation:
    case MemoryType.User:
    case MemoryType.Project:
    case MemoryType.Organization:
    case MemoryType.Session:
    case MemoryType.LongTerm:
    case MemoryType.Archived:
      return true;
  }
}

/**
 * Policy engine interface for composable authorization rules.
 * Each policy evaluates one aspect of the authorization decision.
 */
export interface AuthorizationPolicy {
  readonly name: string;
  evaluate(input: MemoryAccessCheckInput): AuthorizationPolicyResult;
}

/** Result of a single policy evaluation. */
export interface AuthorizationPolicyResult {
  readonly allowed: boolean;
  readonly reason?: string;
  readonly code?: string;
}

/** Default deny policy for fail-closed behavior. */
export class DenyAllPolicy implements AuthorizationPolicy {
  readonly name = 'deny-all-policy';

  evaluate(): AuthorizationPolicyResult {
    return { allowed: false, reason: 'Denied by default (fail-closed)', code: 'DENY_ALL' };
  }
}

/** Matrix-based permission policy. */
export class MatrixPermissionPolicy implements AuthorizationPolicy {
  readonly name = 'matrix-permission-policy';

  evaluate(input: MemoryAccessCheckInput): AuthorizationPolicyResult {
    const { actor, permission, target } = input;
    const allowed = (MEMORY_ACCESS_MATRIX[actor.group]?.[target.type] ?? []).includes(permission);

    if (!allowed) {
      return {
        allowed: false,
        reason: `Actor group ${actor.group} lacks ${permission} permission on ${target.type}`,
        code: 'INSUFFICIENT_PERMISSION',
      };
    }
    return { allowed: true };
  }
}

/** Namespace scope policy. */
export class NamespaceScopePolicy implements AuthorizationPolicy {
  readonly name = 'namespace-scope-policy';

  evaluate(input: MemoryAccessCheckInput): AuthorizationPolicyResult {
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

/** Ownership validation policy. */
export class OwnershipPolicy implements AuthorizationPolicy {
  readonly name = 'ownership-policy';

  evaluate(input: MemoryAccessCheckInput): AuthorizationPolicyResult {
    const { actor, target } = input;

    // If no owner info on target, skip (legacy records)
    if (!target.owner) {
      return { allowed: true };
    }

    const { kind, id } = target.owner;

    // System/Agent ownership — only AG-002/Admin can access
    if (kind === MemoryOwnerKind.System || kind === MemoryOwnerKind.Agent) {
      if (
        actor.group !== MemoryActorGroup.MemoryManager &&
        actor.group !== MemoryActorGroup.Admin
      ) {
        return {
          allowed: false,
          reason: 'System/agent owned memory requires elevated privileges',
          code: 'OWNERSHIP_VIOLATION',
        };
      }
      return { allowed: true };
    }

    // User ownership — check if actor owns or has explicit permission
    if (kind === MemoryOwnerKind.User) {
      const actorUserId = actor.id;
      if (actorUserId && actorUserId === id) {
        return { allowed: true };
      }
      // Client/Freelancer/Markeplace/Admin may have cross-user access via matrix
      // The matrix already handles this, so we allow if matrix grants
      return { allowed: true };
    }

    // Project/Workspace/Organization ownership — scope check
    const actorScopeId = this.getActorScopeId(actor, kind);
    if (actorScopeId && actorScopeId === id) {
      return { allowed: true };
    }

    return {
      allowed: false,
      reason: `Actor does not own ${kind.toLowerCase()} ${id}`,
      code: 'OWNERSHIP_VIOLATION',
    };
  }

  private getActorScopeId(actor: MemoryActor, kind: MemoryOwnerKind): string | undefined {
    switch (kind) {
      case MemoryOwnerKind.Project:
        return actor.projectIds?.[0];
      case MemoryOwnerKind.Workspace:
        return actor.workspaceId;
      case MemoryOwnerKind.Organization:
        return actor.organizationId;
      default:
        return undefined;
    }
  }
}

/** Security level enforcement policy. */
export class SecurityLevelPolicy implements AuthorizationPolicy {
  readonly name = 'security-level-policy';

  evaluate(input: MemoryAccessCheckInput): AuthorizationPolicyResult {
    const { actor, target } = input;

    // If actor has no security clearance, they can only access Internal
    const actorClearance = actor.securityClearance ?? MemorySecurityLevel.Internal;
    const targetLevel = target.securityLevel;

    if (this.isLevelHigher(targetLevel, actorClearance)) {
      return {
        allowed: false,
        reason: `Actor clearance ${actorClearance} insufficient for ${targetLevel} memory`,
        code: 'SECURITY_LEVEL_VIOLATION',
      };
    }
    return { allowed: true };
  }

  private isLevelHigher(target: MemorySecurityLevel, actor: MemorySecurityLevel): boolean {
    // Confidential > Internal
    return target === MemorySecurityLevel.Confidential && actor === MemorySecurityLevel.Internal;
  }
}

/** Lifecycle state access policy. */
export class LifecycleStatePolicy implements AuthorizationPolicy {
  readonly name = 'lifecycle-state-policy';

  evaluate(input: MemoryAccessCheckInput): AuthorizationPolicyResult {
    const { permission, target } = input;

    switch (target.lifecycle) {
      case MemoryLifecycleState.Deleted:
        // No access to deleted memory
        return {
          allowed: false,
          reason: 'Deleted memory is not accessible',
          code: 'LIFECYCLE_VIOLATION',
        };
      case MemoryLifecycleState.Archived:
        // Archived: READ, RESTORE, and DELETE (for DSR/retention job)
        if (
          permission !== MemoryPermission.Read &&
          permission !== MemoryPermission.Restore &&
          permission !== MemoryPermission.Delete
        ) {
          return {
            allowed: false,
            reason: `Archived memory only allows READ/RESTORE/DELETE, not ${permission}`,
            code: 'LIFECYCLE_VIOLATION',
          };
        }
        break;
      case MemoryLifecycleState.Expired:
        // Expired: limited access
        if (
          permission !== MemoryPermission.Read &&
          permission !== MemoryPermission.Archive &&
          permission !== MemoryPermission.Delete
        ) {
          return {
            allowed: false,
            reason: `Expired memory has restricted access`,
            code: 'LIFECYCLE_VIOLATION',
          };
        }
        break;
      case MemoryLifecycleState.Active:
      case MemoryLifecycleState.Created:
        // Normal policy evaluation
        break;
    }
    return { allowed: true };
  }
}

/** Composite policy that evaluates all policies in sequence (fail-closed). */
export class CompositeAuthorizationPolicy implements AuthorizationPolicy {
  readonly name = 'composite-authorization-policy';

  constructor(private readonly policies: readonly AuthorizationPolicy[]) {}

  evaluate(input: MemoryAccessCheckInput): AuthorizationPolicyResult {
    for (const policy of this.policies) {
      const result = policy.evaluate(input);
      if (!result.allowed) {
        return result;
      }
    }
    return { allowed: true };
  }
}

/** Default authorization service implementation. */
export class DefaultAuthorizationService implements AuthorizationService {
  readonly name = 'default-authorization-service';

  private readonly compositePolicy: AuthorizationPolicy;

  constructor() {
    this.compositePolicy = new CompositeAuthorizationPolicy([
      new MatrixPermissionPolicy(),
      new NamespaceScopePolicy(),
      new OwnershipPolicy(),
      new SecurityLevelPolicy(),
      new LifecycleStatePolicy(),
      // DenyAllPolicy is NOT included - fail-closed is achieved by returning deny
      // when any policy denies. If all policies pass, access is allowed.
    ]);
  }

  authorize(input: MemoryAccessCheckInput): AuthorizationDecision {
    // Validate actor context
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
export function createAuthorizationService(
  policies?: readonly AuthorizationPolicy[],
): AuthorizationService {
  class ConfiguredAuthorizationService implements AuthorizationService {
    readonly name = 'configured-authorization-service';
    private readonly composite: AuthorizationPolicy;

    constructor(pols: readonly AuthorizationPolicy[]) {
      const effectivePolicies =
        pols.length > 0
          ? pols
          : [
              new MatrixPermissionPolicy(),
              new NamespaceScopePolicy(),
              new OwnershipPolicy(),
              new SecurityLevelPolicy(),
              new LifecycleStatePolicy(),
            ];
      this.composite = new CompositeAuthorizationPolicy(effectivePolicies);
    }

    authorize(input: MemoryAccessCheckInput): AuthorizationDecision {
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
  return new ConfiguredAuthorizationService(policies ?? []);
}

/** Validates an actor context for completeness (fail-closed). */
export function validateActorContext(actor: unknown): asserts actor is MemoryActor {
  if (!actor || typeof actor !== 'object') {
    throw new MemoryAccessDeniedError('Actor context is missing', {
      code: 'INVALID_ACTOR_CONTEXT',
    });
  }
  const a = actor as Record<string, unknown>;
  if (!a.group || typeof a.group !== 'string') {
    throw new MemoryAccessDeniedError('Actor group is required', { code: 'INVALID_ACTOR_CONTEXT' });
  }
}
