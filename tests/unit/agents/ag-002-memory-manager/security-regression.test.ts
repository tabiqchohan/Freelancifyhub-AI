import { describe, expect, it } from 'vitest';

import {
  MemoryActorGroup,
  MemoryLifecycleState,
  MemoryOwnerKind,
  MemoryPermission,
  MemorySecurityLevel,
  MemoryType,
} from '../../../../src/agents/ag-002-memory-manager/enums/index.js';
import {
  MEMORY_ACCESS_MATRIX,
  MatrixMemoryAccessPolicy,
} from '../../../../src/agents/ag-002-memory-manager/security/index.js';
import {
  createTestEnv,
  clientActor,
  makeActor,
  makeCreateInput,
  makeOwner,
  makeRecord,
} from './fixtures.js';

const groups = Object.values(MemoryActorGroup) as MemoryActorGroup[];
const types = Object.values(MemoryType) as MemoryType[];

function perms(group: MemoryActorGroup, type: MemoryType): readonly MemoryPermission[] {
  return MEMORY_ACCESS_MATRIX[group][type];
}

describe('security-regression - full matrix lock-down (spec §7)', () => {
  it('the matrix is a complete 7x11 table of permission arrays', () => {
    expect(groups).toHaveLength(7);
    expect(types).toHaveLength(11);
    for (const group of groups) {
      for (const type of types) {
        expect(Array.isArray(MEMORY_ACCESS_MATRIX[group][type]), `${group}->${type}`).toBe(true);
      }
    }
  });

  it('only AG-002 may delete conversation memory (Admin is read-only)', () => {
    const conversationDeleters = groups.filter((group) =>
      perms(group, MemoryType.Conversation).includes(MemoryPermission.Delete),
    );
    expect(conversationDeleters).toEqual([MemoryActorGroup.MemoryManager]);
  });

  it('client and freelancer may write own-scoped conversation/user/project but never delete', () => {
    for (const group of [MemoryActorGroup.Client, MemoryActorGroup.Freelancer]) {
      const p = perms(group, MemoryType.Conversation);
      expect(p).toContain(MemoryPermission.Write);
      expect(p).toContain(MemoryPermission.Update);
      expect(p).not.toContain(MemoryPermission.Delete);
      expect(perms(group, MemoryType.Organization)).toEqual([MemoryPermission.Read]);
      expect(perms(group, MemoryType.Workspace)).toEqual([MemoryPermission.Read]);
    }
  });

  it('marketing and marketplace are read-only on user memory (no writes)', () => {
    for (const group of [MemoryActorGroup.Marketing, MemoryActorGroup.Marketplace]) {
      const p = perms(group, MemoryType.User);
      expect(p).toContain(MemoryPermission.Read);
      expect(p).not.toContain(MemoryPermission.Write);
      expect(p).not.toContain(MemoryPermission.Update);
      expect(p).not.toContain(MemoryPermission.Delete);
    }
  });

  it('orchestrator has RWU only on short-term/session; read-only (never delete) everywhere else', () => {
    for (const type of types) {
      const p = perms(MemoryActorGroup.Orchestrator, type);
      expect(p, type).not.toContain(MemoryPermission.Delete);
      const rw = type === MemoryType.ShortTerm || type === MemoryType.Session;
      expect(p.includes(MemoryPermission.Write), `${type} write`).toBe(rw);
      expect(p.includes(MemoryPermission.Update), `${type} update`).toBe(rw);
      expect(p).toContain(MemoryPermission.Read);
    }
  });

  it('admin is read-only on conversation and project, write-only on user', () => {
    expect(perms(MemoryActorGroup.Admin, MemoryType.Conversation)).toEqual([MemoryPermission.Read]);
    expect(perms(MemoryActorGroup.Admin, MemoryType.Project)).toEqual([MemoryPermission.Read]);
    expect(perms(MemoryActorGroup.Admin, MemoryType.User)).toEqual([MemoryPermission.Write]);
    expect(perms(MemoryActorGroup.Admin, MemoryType.Organization)).toContain(
      MemoryPermission.Delete,
    );
  });

  it('AG-002 write-only on user, no delete on session, RW on knowledge refs', () => {
    expect(perms(MemoryActorGroup.MemoryManager, MemoryType.User)).toEqual([
      MemoryPermission.Write,
    ]);
    expect(perms(MemoryActorGroup.MemoryManager, MemoryType.Session)).toEqual([
      MemoryPermission.Read,
    ]);
    expect(perms(MemoryActorGroup.MemoryManager, MemoryType.KnowledgeReference)).toEqual([
      MemoryPermission.Read,
      MemoryPermission.Write,
    ]);
  });
});

describe('security-regression - policy integration (U)', () => {
  it('scope narrowing still holds through the full service path', async () => {
    const { service } = createTestEnv();
    await service.createMemory(makeCreateInput());
    const crossTenant = makeActor(MemoryActorGroup.Client, ['user:2']);
    const results = await service.retrieveMemory({ actor: crossTenant, namespace: 'user:1' });
    expect(results).toEqual([]);
    await expect(
      service.getMemory({ actor: crossTenant, namespace: 'user:1', key: 'pref_theme' }),
    ).rejects.toThrow(/denied/i);
  });

  it('AG-002 cannot read user memory even in scope (write-only row)', async () => {
    const { service } = createTestEnv();
    const created = await service.createMemory(makeCreateInput());
    await expect(
      service.getMemory({
        actor: makeActor(MemoryActorGroup.MemoryManager, ['user:1']),
        namespace: created.namespace,
        key: created.key,
      }),
    ).rejects.toThrow(/denied/i);
  });

  it('archiving requires delete-class permission and fails otherwise', async () => {
    const { service } = createTestEnv();
    const created = await service.createMemory(
      makeCreateInput({
        type: MemoryType.Conversation,
        owner: makeOwner(MemoryOwnerKind.User, '1'),
      }),
    );
    await expect(
      service.archiveMemory({
        actor: clientActor,
        namespace: 'user:1',
        key: created.key,
        reason: 'x',
      }),
    ).rejects.toThrow(/denied/i);
  });

  it('soft-deleted records are invisible to every reader', async () => {
    const { service } = createTestEnv();
    const created = await service.createMemory(
      makeCreateInput({
        type: MemoryType.Conversation,
        owner: makeOwner(MemoryOwnerKind.User, '1'),
      }),
    );
    await service.deleteMemory({
      actor: makeActor(MemoryActorGroup.MemoryManager, ['user:1']),
      namespace: created.namespace,
      key: created.key,
      reason: 'dsr',
    });
    await expect(
      service.getMemory({
        actor: makeActor(MemoryActorGroup.MemoryManager, ['user:1']),
        namespace: created.namespace,
        key: created.key,
      }),
    ).rejects.toThrow(/not found/i);
  });

  it('explicit namespace allow-list is enforced even when the matrix grants', () => {
    const policy = new MatrixMemoryAccessPolicy();
    const actor = makeActor(MemoryActorGroup.Admin, ['org:1']);
    expect(
      policy.can({
        actor,
        permission: MemoryPermission.Read,
        target: {
          namespace: 'org:2',
          type: MemoryType.Organization,
          securityLevel: MemorySecurityLevel.Confidential,
        },
      }),
    ).toBe(false);
    expect(
      policy.can({
        actor,
        permission: MemoryPermission.Read,
        target: {
          namespace: 'org:1',
          type: MemoryType.Organization,
          securityLevel: MemorySecurityLevel.Confidential,
        },
      }),
    ).toBe(true);
  });

  it('declined tombstone records never leak through retrieval', async () => {
    const { service, repository } = createTestEnv();
    await service.createMemory(makeCreateInput());
    await repository.save(
      makeRecord({
        namespace: 'user:1',
        key: 'gone',
        lifecycle: MemoryLifecycleState.Deleted,
      }),
    );
    const results = await service.retrieveMemory({
      actor: makeActor(MemoryActorGroup.Client, ['user:1']),
      namespace: 'user:1',
    });
    expect(results.map((r) => r.record.key)).not.toContain('gone');
  });
});
