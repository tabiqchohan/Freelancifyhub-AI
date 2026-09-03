import { describe, expect, it } from 'vitest';

import {
  KnowledgeActorGroup,
  KnowledgeLifecycleState,
  KnowledgePermission,
  KnowledgeSecurityLevel,
} from '../../../../src/agents/ag-003-knowledge-manager/enums/index.js';
import { DefaultKnowledgeLifecycle } from '../../../../src/agents/ag-003-knowledge-manager/lifecycle/index.js';
import { KnowledgeLifecycleTransitionError } from '../../../../src/agents/ag-003-knowledge-manager/errors/index.js';
import {
  DefaultKnowledgeAuthorizationService,
  createKnowledgeAuthorizationService,
} from '../../../../src/agents/ag-003-knowledge-manager/security/index.js';

const lifecycle = new DefaultKnowledgeLifecycle();
const S = KnowledgeLifecycleState;

describe('AG-003 lifecycle - valid transitions', () => {
  it('allows Active -> Archived', () => {
    expect(lifecycle.canTransition(S.Active, S.Archived)).toBe(true);
  });
  it('allows Active -> Expired -> Deleted', () => {
    expect(lifecycle.canTransition(S.Active, S.Expired)).toBe(true);
    expect(lifecycle.canTransition(S.Expired, S.Deleted)).toBe(true);
  });
  it('allows Archived -> Active (restore)', () => {
    expect(lifecycle.canTransition(S.Archived, S.Active)).toBe(true);
  });
});

describe('AG-003 lifecycle - invalid transitions are rejected (fail-closed)', () => {
  it('Deleted is terminal', () => {
    expect(lifecycle.canTransition(S.Deleted, S.Active)).toBe(false);
    expect(() => lifecycle.transition(S.Deleted, S.Active)).toThrow(
      KnowledgeLifecycleTransitionError,
    );
  });
  it('Active -> Active is invalid', () => {
    expect(lifecycle.canTransition(S.Active, S.Active)).toBe(false);
  });
});

describe('AG-003 authorization - deterministic and fail-closed', () => {
  const svc = new DefaultKnowledgeAuthorizationService();

  it('allows authorized read with matching namespace', () => {
    const decision = svc.authorize({
      actor: { group: KnowledgeActorGroup.Client, namespaces: ['user:1'] },
      permission: KnowledgePermission.Read,
      target: {
        namespace: 'user:1',
        securityLevel: KnowledgeSecurityLevel.Internal,
        lifecycle: KnowledgeLifecycleState.Active,
      },
    });
    expect(decision.allowed).toBe(true);
  });

  it('denies cross-namespace access', () => {
    const decision = svc.authorize({
      actor: { group: KnowledgeActorGroup.Client, namespaces: ['user:1'] },
      permission: KnowledgePermission.Read,
      target: {
        namespace: 'user:2',
        securityLevel: KnowledgeSecurityLevel.Internal,
        lifecycle: KnowledgeLifecycleState.Active,
      },
    });
    expect(decision.allowed).toBe(false);
  });

  it('denies missing actor context', () => {
    const decision = svc.authorize({
      // @ts-expect-error - intentionally missing actor group
      actor: {},
      permission: KnowledgePermission.Read,
      target: {
        namespace: 'user:1',
        securityLevel: KnowledgeSecurityLevel.Internal,
        lifecycle: KnowledgeLifecycleState.Active,
      },
    });
    expect(decision.allowed).toBe(false);
  });

  it('denies restricted (confidential) knowledge to internal clearance', () => {
    const decision = svc.authorize({
      actor: {
        group: KnowledgeActorGroup.Client,
        namespaces: ['user:1'],
        securityClearance: KnowledgeSecurityLevel.Internal,
      },
      permission: KnowledgePermission.Read,
      target: {
        namespace: 'user:1',
        securityLevel: KnowledgeSecurityLevel.Confidential,
        lifecycle: KnowledgeLifecycleState.Active,
      },
    });
    expect(decision.allowed).toBe(false);
  });

  it('denies deleted knowledge entirely', () => {
    const decision = svc.authorize({
      actor: { group: KnowledgeActorGroup.Admin, namespaces: ['user:1'] },
      permission: KnowledgePermission.Read,
      target: {
        namespace: 'user:1',
        securityLevel: KnowledgeSecurityLevel.Internal,
        lifecycle: KnowledgeLifecycleState.Deleted,
      },
    });
    expect(decision.allowed).toBe(false);
  });

  it('allows knowledge manager to create', () => {
    const decision = svc.authorize({
      actor: { group: KnowledgeActorGroup.KnowledgeManager, namespaces: ['user:1'] },
      permission: KnowledgePermission.Create,
      target: {
        namespace: 'user:1',
        securityLevel: KnowledgeSecurityLevel.Internal,
        lifecycle: KnowledgeLifecycleState.Active,
      },
    });
    expect(decision.allowed).toBe(true);
  });

  it('denies normal client from deleting', () => {
    const decision = svc.authorize({
      actor: { group: KnowledgeActorGroup.Client, namespaces: ['user:1'] },
      permission: KnowledgePermission.DeleteErase,
      target: {
        namespace: 'user:1',
        securityLevel: KnowledgeSecurityLevel.Internal,
        lifecycle: KnowledgeLifecycleState.Active,
      },
    });
    expect(decision.allowed).toBe(false);
  });

  it('createKnowledgeAuthorizationService builds a working service', () => {
    const custom = createKnowledgeAuthorizationService();
    const decision = custom.authorize({
      actor: { group: KnowledgeActorGroup.Admin, namespaces: ['org:1'] },
      permission: KnowledgePermission.Read,
      target: {
        namespace: 'org:1',
        securityLevel: KnowledgeSecurityLevel.Internal,
        lifecycle: KnowledgeLifecycleState.Active,
      },
    });
    expect(decision.allowed).toBe(true);
  });
});
