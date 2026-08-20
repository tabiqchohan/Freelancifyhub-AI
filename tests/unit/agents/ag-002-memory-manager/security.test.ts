import { describe, expect, it } from 'vitest';

import {
  MemoryActorGroup,
  MemoryPermission,
  MemorySecurityLevel,
  MemoryType,
} from '../../../../src/agents/ag-002-memory-manager/enums/index.js';
import {
  MEMORY_ACCESS_MATRIX,
  MatrixMemoryAccessPolicy,
  isConfidentialSecurityLevel,
  isConfidentialType,
} from '../../../../src/agents/ag-002-memory-manager/security/index.js';
import { makeActor } from './fixtures.js';

const policy = new MatrixMemoryAccessPolicy();

function target(
  type: MemoryType,
  namespace = 'user:1',
  securityLevel = MemorySecurityLevel.Confidential,
) {
  return { namespace, type, securityLevel };
}

describe('access matrix - spec §7 rows', () => {
  it('AG-001: RWU short-term/session, read-only elsewhere, never deletes', () => {
    const actor = makeActor(MemoryActorGroup.Orchestrator, ['system:plans', 'user:1']);
    expect(
      policy.can({
        actor,
        permission: MemoryPermission.Write,
        target: target(MemoryType.ShortTerm),
      }),
    ).toBe(true);
    expect(
      policy.can({
        actor,
        permission: MemoryPermission.Update,
        target: target(MemoryType.Session),
      }),
    ).toBe(true);
    expect(
      policy.can({
        actor,
        permission: MemoryPermission.Read,
        target: target(MemoryType.Conversation),
      }),
    ).toBe(true);
    expect(
      policy.can({
        actor,
        permission: MemoryPermission.Write,
        target: target(MemoryType.Conversation),
      }),
    ).toBe(false);
    expect(
      policy.can({
        actor,
        permission: MemoryPermission.Delete,
        target: target(MemoryType.ShortTerm),
      }),
    ).toBe(false);
    expect(
      policy.can({
        actor,
        permission: MemoryPermission.Delete,
        target: target(MemoryType.Conversation),
      }),
    ).toBe(false);
  });

  it('AG-002: full RWUD on most types, write-only on user, RW on knowledge refs', () => {
    const actor = makeActor(MemoryActorGroup.MemoryManager, ['user:1', 'system:canonical']);
    expect(
      policy.can({
        actor,
        permission: MemoryPermission.Delete,
        target: target(MemoryType.Conversation),
      }),
    ).toBe(true);
    expect(
      policy.can({
        actor,
        permission: MemoryPermission.Write,
        target: target(MemoryType.Workspace),
      }),
    ).toBe(true);
    expect(
      policy.can({
        actor,
        permission: MemoryPermission.Update,
        target: target(MemoryType.Archived),
      }),
    ).toBe(true);
    expect(
      policy.can({
        actor,
        permission: MemoryPermission.Read,
        target: target(MemoryType.KnowledgeReference),
      }),
    ).toBe(true);
    expect(
      policy.can({
        actor,
        permission: MemoryPermission.Write,
        target: target(MemoryType.KnowledgeReference),
      }),
    ).toBe(true);
    expect(
      policy.can({
        actor,
        permission: MemoryPermission.Delete,
        target: target(MemoryType.KnowledgeReference),
      }),
    ).toBe(false);
    expect(
      policy.can({ actor, permission: MemoryPermission.Read, target: target(MemoryType.User) }),
    ).toBe(false);
    expect(
      policy.can({ actor, permission: MemoryPermission.Update, target: target(MemoryType.User) }),
    ).toBe(false);
    expect(
      policy.can({ actor, permission: MemoryPermission.Write, target: target(MemoryType.User) }),
    ).toBe(true);
    expect(
      policy.can({
        actor,
        permission: MemoryPermission.Delete,
        target: target(MemoryType.Session),
      }),
    ).toBe(false);
  });

  it('Client/Freelancer: RWU own-scoped memory, read-only elsewhere, write-only long-term', () => {
    for (const group of [MemoryActorGroup.Client, MemoryActorGroup.Freelancer]) {
      const actor = makeActor(group, ['user:1']);
      expect(
        policy.can({ actor, permission: MemoryPermission.Write, target: target(MemoryType.User) }),
      ).toBe(true);
      expect(
        policy.can({
          actor,
          permission: MemoryPermission.Update,
          target: target(MemoryType.Conversation),
        }),
      ).toBe(true);
      expect(
        policy.can({
          actor,
          permission: MemoryPermission.Delete,
          target: target(MemoryType.Conversation),
        }),
      ).toBe(false);
      expect(
        policy.can({
          actor,
          permission: MemoryPermission.Write,
          target: target(MemoryType.Organization),
        }),
      ).toBe(false);
      expect(
        policy.can({
          actor,
          permission: MemoryPermission.Write,
          target: target(MemoryType.LongTerm),
        }),
      ).toBe(true);
      expect(
        policy.can({
          actor,
          permission: MemoryPermission.Delete,
          target: target(MemoryType.LongTerm),
        }),
      ).toBe(false);
    }
  });

  it('Marketplace: RWU project/temporary, RW knowledge refs, read-only elsewhere', () => {
    const actor = makeActor(MemoryActorGroup.Marketplace, ['project:1']);
    expect(
      policy.can({
        actor,
        permission: MemoryPermission.Update,
        target: target(MemoryType.Project, 'project:1'),
      }),
    ).toBe(true);
    expect(
      policy.can({
        actor,
        permission: MemoryPermission.Write,
        target: target(MemoryType.Temporary, 'project:1'),
      }),
    ).toBe(true);
    expect(
      policy.can({
        actor,
        permission: MemoryPermission.Write,
        target: target(MemoryType.KnowledgeReference, 'project:1'),
      }),
    ).toBe(true);
    expect(
      policy.can({
        actor,
        permission: MemoryPermission.Write,
        target: target(MemoryType.User, 'project:1'),
      }),
    ).toBe(false);
    expect(
      policy.can({
        actor,
        permission: MemoryPermission.Delete,
        target: target(MemoryType.Project, 'project:1'),
      }),
    ).toBe(false);
  });

  it('Marketing: RWU short-term/workspace/temporary, read-only elsewhere', () => {
    const actor = makeActor(MemoryActorGroup.Marketing, ['workspace:1']);
    expect(
      policy.can({
        actor,
        permission: MemoryPermission.Write,
        target: target(MemoryType.Workspace, 'workspace:1'),
      }),
    ).toBe(true);
    expect(
      policy.can({
        actor,
        permission: MemoryPermission.Update,
        target: target(MemoryType.ShortTerm, 'workspace:1'),
      }),
    ).toBe(true);
    expect(
      policy.can({
        actor,
        permission: MemoryPermission.Write,
        target: target(MemoryType.Conversation, 'workspace:1'),
      }),
    ).toBe(false);
    expect(
      policy.can({
        actor,
        permission: MemoryPermission.Write,
        target: target(MemoryType.Project, 'workspace:1'),
      }),
    ).toBe(false);
    expect(
      policy.can({
        actor,
        permission: MemoryPermission.Delete,
        target: target(MemoryType.Workspace, 'workspace:1'),
      }),
    ).toBe(false);
  });

  it('Admin: RWUD org/workspace/kb/long-term/archived, write-only user, read-only conversation/project', () => {
    const actor = makeActor(MemoryActorGroup.Admin, ['org:1', 'user:1']);
    expect(
      policy.can({
        actor,
        permission: MemoryPermission.Delete,
        target: target(MemoryType.Organization),
      }),
    ).toBe(true);
    expect(
      policy.can({
        actor,
        permission: MemoryPermission.Update,
        target: target(MemoryType.Archived),
      }),
    ).toBe(true);
    expect(
      policy.can({ actor, permission: MemoryPermission.Write, target: target(MemoryType.User) }),
    ).toBe(true);
    expect(
      policy.can({ actor, permission: MemoryPermission.Read, target: target(MemoryType.User) }),
    ).toBe(false);
    expect(
      policy.can({
        actor,
        permission: MemoryPermission.Write,
        target: target(MemoryType.Conversation),
      }),
    ).toBe(false);
    expect(
      policy.can({ actor, permission: MemoryPermission.Write, target: target(MemoryType.Project) }),
    ).toBe(false);
    expect(
      policy.can({
        actor,
        permission: MemoryPermission.Delete,
        target: target(MemoryType.Temporary),
      }),
    ).toBe(false);
  });
});

describe('access matrix - every group has a denial (matrix is not a blank cheque)', () => {
  it('no group holds DELETE on conversation except AG-002 (and Admin read-only)', () => {
    for (const group of Object.values(MemoryActorGroup)) {
      const actor = makeActor(group, ['user:1']);
      const allowed =
        group === MemoryActorGroup.MemoryManager
          ? policy.can({
              actor,
              permission: MemoryPermission.Delete,
              target: target(MemoryType.Conversation),
            })
          : !policy.can({
              actor,
              permission: MemoryPermission.Delete,
              target: target(MemoryType.Conversation),
            });
      expect(allowed).toBe(true);
    }
  });
});

describe('access scope - fail-closed cross-namespace isolation (spec §7, AC-MEM-2)', () => {
  it('rejects an actor with no allow-list 100%', () => {
    const actor = makeActor(MemoryActorGroup.Admin, []);
    expect(
      policy.can({ actor, permission: MemoryPermission.Read, target: target(MemoryType.Project) }),
    ).toBe(false);
  });

  it('rejects reads outside the actor allow-list even when the matrix grants read', () => {
    const actor = makeActor(MemoryActorGroup.Client, ['user:1']);
    expect(
      policy.can({
        actor,
        permission: MemoryPermission.Read,
        target: target(MemoryType.Conversation, 'user:99'),
      }),
    ).toBe(false);
  });

  it('allows reads inside the allow-list', () => {
    const actor = makeActor(MemoryActorGroup.Client, ['user:1']);
    expect(
      policy.can({
        actor,
        permission: MemoryPermission.Read,
        target: target(MemoryType.Conversation, 'user:1'),
      }),
    ).toBe(true);
  });

  it('exposes the full matrix for every group and type', () => {
    for (const group of Object.values(MemoryActorGroup)) {
      for (const type of Object.values(MemoryType)) {
        expect(MEMORY_ACCESS_MATRIX[group][type]).toBeDefined();
      }
    }
  });
});

describe('security levels (spec §4, §13)', () => {
  it('flags confidential levels and types', () => {
    expect(isConfidentialSecurityLevel(MemorySecurityLevel.Confidential)).toBe(true);
    expect(isConfidentialSecurityLevel(MemorySecurityLevel.Internal)).toBe(false);
    expect(isConfidentialType(MemoryType.Conversation)).toBe(true);
    expect(isConfidentialType(MemoryType.User)).toBe(true);
    expect(isConfidentialType(MemoryType.ShortTerm)).toBe(false);
    expect(isConfidentialType(MemoryType.Temporary)).toBe(false);
  });
});
