import { describe, expect, it } from 'vitest';

import {
  DefaultToolAuthorizationService,
  createToolAuthorizationService,
  ToolActorGroup,
  ToolPermission,
  ToolSecurityLevel,
  ToolMatrixPermissionPolicy,
  ToolNamespaceScopePolicy,
  ToolSecurityLevelPolicy,
  ToolAccessDeniedError,
} from '../../../../src/agents/ag-004-tool-manager/index.js';
import { validateToolActorContext } from '../../../../src/agents/ag-004-tool-manager/security/index.js';
import type { ToolActor } from '../../../../src/agents/ag-004-tool-manager/types/index.js';

const decisionService = new DefaultToolAuthorizationService();

function target(overrides: Record<string, unknown> = {}) {
  return {
    toolId: 'tool:x:v1.0.0',
    toolName: 'x',
    toolVersion: '1.0.0',
    namespace: 'default',
    securityLevel: ToolSecurityLevel.Internal,
    enabled: true,
    ...overrides,
  };
}

describe('AG-004 Tool Security - deny-by-default authorization', () => {
  it('allows execute for an actor with scope and clearance', () => {
    const actor: ToolActor = {
      group: ToolActorGroup.Orchestrator,
      id: 'o-1',
      namespaces: ['default'],
      securityClearance: ToolSecurityLevel.Internal,
    };
    const d = decisionService.authorize({
      actor,
      permission: ToolPermission.Execute,
      target: target(),
    });
    expect(d.allowed).toBe(true);
  });

  it('rejects when the actor group lacks the permission', () => {
    const actor: ToolActor = {
      group: ToolActorGroup.Marketing,
      id: 'm-1',
      namespaces: ['default'],
      securityClearance: ToolSecurityLevel.Internal,
    };
    const d = decisionService.authorize({
      actor,
      permission: ToolPermission.Execute,
      target: target(),
    });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('INSUFFICIENT_PERMISSION');
  });

  it('rejects an actor with no namespace scope (fail closed)', () => {
    const actor: ToolActor = { group: ToolActorGroup.Orchestrator, id: 'o-2' };
    const d = decisionService.authorize({
      actor,
      permission: ToolPermission.Execute,
      target: target(),
    });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('MISSING_SCOPE');
  });

  it('rejects out-of-scope namespace access', () => {
    const actor: ToolActor = {
      group: ToolActorGroup.Orchestrator,
      namespaces: ['other'],
      securityClearance: ToolSecurityLevel.Internal,
    };
    const d = decisionService.authorize({
      actor,
      permission: ToolPermission.Execute,
      target: target({ namespace: 'default' }),
    });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('SCOPE_VIOLATION');
  });

  it('rejects execute on a disabled tool', () => {
    const actor: ToolActor = {
      group: ToolActorGroup.Orchestrator,
      namespaces: ['default'],
      securityClearance: ToolSecurityLevel.Internal,
    };
    const d = decisionService.authorize({
      actor,
      permission: ToolPermission.Execute,
      target: target({ enabled: false }),
    });
    expect(d.allowed).toBe(false);
  });

  it('denies access for missing/invalid actor context', () => {
    const d = decisionService.authorize({
      actor: {} as ToolActor,
      permission: ToolPermission.Execute,
      target: target(),
    });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('INVALID_ACTOR_CONTEXT');
  });

  it('rejects confidential tool for internal clearance', () => {
    const actor: ToolActor = {
      group: ToolActorGroup.Orchestrator,
      namespaces: ['default'],
      securityClearance: ToolSecurityLevel.Internal,
    };
    const d = decisionService.authorize({
      actor,
      permission: ToolPermission.Execute,
      target: target({ securityLevel: ToolSecurityLevel.Confidential }),
    });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('SECURITY_LEVEL_VIOLATION');
  });

  it('allows Admin to manage tools', () => {
    const actor: ToolActor = {
      group: ToolActorGroup.Admin,
      namespaces: ['default'],
      securityClearance: ToolSecurityLevel.Internal,
    };
    const d = decisionService.authorize({
      actor,
      permission: ToolPermission.Register,
      target: target(),
    });
    expect(d.allowed).toBe(true);
  });

  it('validateToolActorContext throws on missing group', () => {
    expect(() => validateToolActorContext({ id: 'x' })).toThrow(ToolAccessDeniedError);
    expect(() => validateToolActorContext(null)).toThrow(ToolAccessDeniedError);
  });

  it('individual policies are injectable', () => {
    const service = createToolAuthorizationService([
      new ToolMatrixPermissionPolicy(),
      new ToolNamespaceScopePolicy(),
      new ToolSecurityLevelPolicy(),
    ]);
    const actor: ToolActor = {
      group: ToolActorGroup.Orchestrator,
      namespaces: ['default'],
      securityClearance: ToolSecurityLevel.Internal,
    };
    const d = service.authorize({ actor, permission: ToolPermission.Execute, target: target() });
    expect(d.allowed).toBe(true);
  });
});
