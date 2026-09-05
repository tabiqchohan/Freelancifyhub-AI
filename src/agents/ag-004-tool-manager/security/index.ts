import { ToolActorGroup, ToolPermission, ToolSecurityLevel } from '../enums/index.js';
import type { ToolActor, ToolNamespace } from '../types/index.js';
import { ToolAccessDeniedError } from '../errors/index.js';

/**
 * AG-004 tool authorization model. Reuses AG-002/AG-003 actor-pattern concepts
 * adapted for tool operations. Fail-closed by design: missing actor/permission
 * information always yields a denial.
 */

/** Target of an access check (the tool being operated on). */
export interface ToolAccessCheckTarget {
  readonly toolId: string;
  readonly toolName: string;
  readonly toolVersion: string;
  readonly namespace: ToolNamespace;
  readonly securityLevel: ToolSecurityLevel;
  readonly enabled: boolean;
  readonly category?: string;
}

/** Input to a single access decision. */
export interface ToolAccessCheckInput {
  readonly actor: ToolActor;
  readonly permission: ToolPermission;
  readonly target: ToolAccessCheckTarget;
}

/** Authorization policy contract (fail-closed by design). */
export interface ToolAuthorizationPolicy {
  readonly name: string;
  evaluate(input: ToolAccessCheckInput): ToolAuthorizationPolicyResult;
}

export interface ToolAuthorizationPolicyResult {
  readonly allowed: boolean;
  readonly reason?: string;
  readonly code?: string;
}

export interface ToolAuthorizationService {
  readonly name: string;
  authorize(input: ToolAccessCheckInput): ToolAuthorizationDecision;
}

export interface ToolAuthorizationDecision {
  readonly allowed: boolean;
  readonly reason?: string;
  readonly code?: string;
}

/**
 * Tool access matrix: permissions per actor group. Fail-closed: missing
 * entries default to denied. Orchestrator and Admin get broad access;
 * ToolManager gets full management; other groups get limited/read access.
 */
export const TOOL_ACCESS_MATRIX: Readonly<Record<ToolActorGroup, readonly ToolPermission[]>> = {
  [ToolActorGroup.Orchestrator]: [
    ToolPermission.Read,
    ToolPermission.Execute,
    ToolPermission.Admin,
  ],
  [ToolActorGroup.MemoryManager]: [ToolPermission.Read, ToolPermission.Execute],
  [ToolActorGroup.KnowledgeManager]: [ToolPermission.Read, ToolPermission.Execute],
  [ToolActorGroup.ToolManager]: [
    ToolPermission.Read,
    ToolPermission.Execute,
    ToolPermission.Register,
    ToolPermission.Update,
    ToolPermission.Enable,
    ToolPermission.Disable,
    ToolPermission.Delete,
    ToolPermission.Admin,
  ],
  [ToolActorGroup.Client]: [ToolPermission.Read, ToolPermission.Execute],
  [ToolActorGroup.Freelancer]: [ToolPermission.Read, ToolPermission.Execute],
  [ToolActorGroup.Marketplace]: [ToolPermission.Read, ToolPermission.Execute],
  [ToolActorGroup.Marketing]: [ToolPermission.Read],
  [ToolActorGroup.Admin]: [
    ToolPermission.Read,
    ToolPermission.Execute,
    ToolPermission.Register,
    ToolPermission.Update,
    ToolPermission.Enable,
    ToolPermission.Disable,
    ToolPermission.Delete,
    ToolPermission.Admin,
  ],
};

/** Matrix-based permission policy. */
export class ToolMatrixPermissionPolicy implements ToolAuthorizationPolicy {
  readonly name = 'tool-matrix-permission-policy';

  evaluate(input: ToolAccessCheckInput): ToolAuthorizationPolicyResult {
    const { actor, permission } = input;
    const granted = TOOL_ACCESS_MATRIX[actor.group] ?? [];
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
export class ToolNamespaceScopePolicy implements ToolAuthorizationPolicy {
  readonly name = 'tool-namespace-scope-policy';

  evaluate(input: ToolAccessCheckInput): ToolAuthorizationPolicyResult {
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
export class ToolSecurityLevelPolicy implements ToolAuthorizationPolicy {
  readonly name = 'tool-security-level-policy';

  evaluate(input: ToolAccessCheckInput): ToolAuthorizationPolicyResult {
    const { actor, target } = input;
    const actorClearance = actor.securityClearance ?? ToolSecurityLevel.Internal;
    if (
      target.securityLevel === ToolSecurityLevel.Confidential &&
      actorClearance === ToolSecurityLevel.Internal
    ) {
      return {
        allowed: false,
        reason: `Actor clearance ${actorClearance} insufficient for ${target.securityLevel} tool`,
        code: 'SECURITY_LEVEL_VIOLATION',
      };
    }
    return { allowed: true };
  }
}

/** Enabled-state enforcement — provides a signal when a tool is disabled. */
export class ToolEnabledPolicy implements ToolAuthorizationPolicy {
  readonly name = 'tool-enabled-policy';

  evaluate(input: ToolAccessCheckInput): ToolAuthorizationPolicyResult {
    const { target, permission } = input;
    if (permission === ToolPermission.Enable) {
      // Enabling a disabled tool is allowed regardless of current state.
      return { allowed: true };
    }
    if (
      !target.enabled &&
      permission !== ToolPermission.Admin &&
      permission !== ToolPermission.Read
    ) {
      return {
        allowed: false,
        reason: `Tool ${target.toolName} is disabled`,
        code: 'TOOL_DISABLED',
      };
    }
    return { allowed: true };
  }
}

/** Composite policy that evaluates all policies in sequence (fail-closed). */
export class CompositeToolAuthorizationPolicy implements ToolAuthorizationPolicy {
  readonly name = 'composite-tool-authorization-policy';

  constructor(private readonly policies: readonly ToolAuthorizationPolicy[]) {}

  evaluate(input: ToolAccessCheckInput): ToolAuthorizationPolicyResult {
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
export class DefaultToolAuthorizationService implements ToolAuthorizationService {
  readonly name = 'default-tool-authorization-service';

  private readonly compositePolicy: ToolAuthorizationPolicy;

  constructor() {
    this.compositePolicy = new CompositeToolAuthorizationPolicy([
      new ToolMatrixPermissionPolicy(),
      new ToolNamespaceScopePolicy(),
      new ToolSecurityLevelPolicy(),
      new ToolEnabledPolicy(),
    ]);
  }

  authorize(input: ToolAccessCheckInput): ToolAuthorizationDecision {
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
export function createToolAuthorizationService(
  policies?: readonly ToolAuthorizationPolicy[],
): ToolAuthorizationService {
  class ConfiguredToolAuthorizationService implements ToolAuthorizationService {
    readonly name = 'configured-tool-authorization-service';
    private readonly composite: ToolAuthorizationPolicy;

    constructor(pols: readonly ToolAuthorizationPolicy[]) {
      const effective =
        pols.length > 0
          ? pols
          : [
              new ToolMatrixPermissionPolicy(),
              new ToolNamespaceScopePolicy(),
              new ToolSecurityLevelPolicy(),
              new ToolEnabledPolicy(),
            ];
      this.composite = new CompositeToolAuthorizationPolicy(effective);
    }

    authorize(input: ToolAccessCheckInput): ToolAuthorizationDecision {
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
  return new ConfiguredToolAuthorizationService(policies ?? []);
}

/** Validates an actor context for completeness (fail-closed). */
export function validateToolActorContext(actor: unknown): asserts actor is ToolActor {
  if (!actor || typeof actor !== 'object') {
    throw new ToolAccessDeniedError('Actor context is missing', {
      code: 'INVALID_ACTOR_CONTEXT',
    });
  }
  const a = actor as Record<string, unknown>;
  if (!a.group || typeof a.group !== 'string') {
    throw new ToolAccessDeniedError('Actor group is required', {
      code: 'INVALID_ACTOR_CONTEXT',
    });
  }
}
