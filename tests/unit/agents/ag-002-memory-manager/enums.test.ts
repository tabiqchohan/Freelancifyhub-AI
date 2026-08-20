import { describe, expect, it } from 'vitest';

import {
  MemoryActorGroup,
  MemoryLifecycleState,
  MemoryOwnerKind,
  MemoryPermission,
  MemoryPriority,
  MemorySecurityLevel,
  MemoryType,
  StorageTier,
} from '../../../../src/agents/ag-002-memory-manager/enums/index.js';

describe('MemoryType - the 11 canonical architecture memory types', () => {
  it('defines exactly the eleven types from the spec (prompt §2)', () => {
    const values = Object.values(MemoryType);
    expect(values).toHaveLength(11);
    expect(values).toEqual(
      expect.arrayContaining([
        'SHORT_TERM',
        'CONVERSATION',
        'USER',
        'PROJECT',
        'WORKSPACE',
        'ORGANIZATION',
        'KNOWLEDGE_REFERENCE',
        'TEMPORARY',
        'SESSION',
        'LONG_TERM',
        'ARCHIVED',
      ]),
    );
  });

  it('exposes each type through a named member', () => {
    expect(MemoryType.ShortTerm).toBe('SHORT_TERM');
    expect(MemoryType.Conversation).toBe('CONVERSATION');
    expect(MemoryType.User).toBe('USER');
    expect(MemoryType.Project).toBe('PROJECT');
    expect(MemoryType.Workspace).toBe('WORKSPACE');
    expect(MemoryType.Organization).toBe('ORGANIZATION');
    expect(MemoryType.KnowledgeReference).toBe('KNOWLEDGE_REFERENCE');
    expect(MemoryType.Temporary).toBe('TEMPORARY');
    expect(MemoryType.Session).toBe('SESSION');
    expect(MemoryType.LongTerm).toBe('LONG_TERM');
    expect(MemoryType.Archived).toBe('ARCHIVED');
  });
});

describe('MemoryLifecycleState - architecture states (spec §5)', () => {
  it('defines created, active, expired, archived and deleted', () => {
    expect(MemoryLifecycleState.Created).toBe('CREATED');
    expect(MemoryLifecycleState.Active).toBe('ACTIVE');
    expect(MemoryLifecycleState.Expired).toBe('EXPIRED');
    expect(MemoryLifecycleState.Archived).toBe('ARCHIVED');
    expect(MemoryLifecycleState.Deleted).toBe('DELETED');
  });
});

describe('MemoryPriority - architecture priority model (spec §4)', () => {
  it('defines low, medium, high and critical', () => {
    expect(MemoryPriority.Low).toBe('LOW');
    expect(MemoryPriority.Medium).toBe('MEDIUM');
    expect(MemoryPriority.High).toBe('HIGH');
    expect(MemoryPriority.Critical).toBe('CRITICAL');
  });
});

describe('MemorySecurityLevel - architecture classification (spec §4)', () => {
  it('defines exactly internal and confidential', () => {
    expect(MemorySecurityLevel.Internal).toBe('INTERNAL');
    expect(MemorySecurityLevel.Confidential).toBe('CONFIDENTIAL');
    expect(Object.values(MemorySecurityLevel)).toHaveLength(2);
  });
});

describe('MemoryPermission - access matrix operations (spec §7)', () => {
  it('defines read, write, update and delete', () => {
    expect(MemoryPermission.Read).toBe('READ');
    expect(MemoryPermission.Write).toBe('WRITE');
    expect(MemoryPermission.Update).toBe('UPDATE');
    expect(MemoryPermission.Delete).toBe('DELETE');
  });
});

describe('MemoryOwnerKind - ownership types (spec §6)', () => {
  it('supports user, project, workspace, organization, agent and system', () => {
    expect(MemoryOwnerKind.User).toBe('USER');
    expect(MemoryOwnerKind.Project).toBe('PROJECT');
    expect(MemoryOwnerKind.Workspace).toBe('WORKSPACE');
    expect(MemoryOwnerKind.Organization).toBe('ORGANIZATION');
    expect(MemoryOwnerKind.Agent).toBe('AGENT');
    expect(MemoryOwnerKind.System).toBe('SYSTEM');
  });
});

describe('MemoryActorGroup - access matrix agent groups (spec §7)', () => {
  it('defines the seven matrix rows', () => {
    expect(Object.values(MemoryActorGroup)).toHaveLength(7);
    expect(MemoryActorGroup.Orchestrator).toBe('ORCHESTRATOR');
    expect(MemoryActorGroup.MemoryManager).toBe('MEMORY_MANAGER');
    expect(MemoryActorGroup.Client).toBe('CLIENT');
    expect(MemoryActorGroup.Freelancer).toBe('FREELANCER');
    expect(MemoryActorGroup.Marketplace).toBe('MARKETPLACE');
    expect(MemoryActorGroup.Marketing).toBe('MARKETING');
    expect(MemoryActorGroup.Admin).toBe('ADMIN');
  });
});

describe('StorageTier - storage strategy tiers (spec §18)', () => {
  it('defines hot, warm and cold', () => {
    expect(StorageTier.Hot).toBe('HOT');
    expect(StorageTier.Warm).toBe('WARM');
    expect(StorageTier.Cold).toBe('COLD');
  });
});
