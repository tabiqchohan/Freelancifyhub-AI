import { describe, expect, it } from 'vitest';

import { MemoryConflictError } from '../../../../src/agents/ag-002-memory-manager/errors/index.js';
import { createTestEnv, makeActor, makeCreateInput, makeOwner } from './fixtures.js';
import {
  MemoryActorGroup,
  MemoryOwnerKind,
  MemoryType,
} from '../../../../src/agents/ag-002-memory-manager/enums/index.js';

describe('versioning - monotonic versions (prompt §21, spec §15)', () => {
  it('starts at version 1', async () => {
    const { service } = createTestEnv();
    const created = await service.createMemory(makeCreateInput());
    expect(created.version).toBe(1);
  });

  it('bumps to version 2 then 3 across updates', async () => {
    const { service } = createTestEnv();
    const created = await service.createMemory(makeCreateInput());
    const v2 = await service.updateMemory({
      actor: makeCreateInput().actor,
      namespace: created.namespace,
      key: created.key,
      expectedVersion: 1,
      reason: 'update 1',
      content: { theme: 'light' },
    });
    expect(v2.version).toBe(2);

    const v3 = await service.updateMemory({
      actor: makeCreateInput().actor,
      namespace: created.namespace,
      key: created.key,
      expectedVersion: 2,
      reason: 'update 2',
      content: { theme: 'blue' },
    });
    expect(v3.version).toBe(3);
  });

  it('throws a conflict when the expected version is stale', async () => {
    const { service } = createTestEnv();
    const created = await service.createMemory(makeCreateInput());
    await service.updateMemory({
      actor: makeCreateInput().actor,
      namespace: created.namespace,
      key: created.key,
      expectedVersion: 1,
      reason: 'update',
      content: { theme: 'light' },
    });
    await expect(
      service.updateMemory({
        actor: makeCreateInput().actor,
        namespace: created.namespace,
        key: created.key,
        expectedVersion: 1,
        reason: 'stale write',
        content: { theme: 'dark' },
      }),
    ).rejects.toBeInstanceOf(MemoryConflictError);
  });

  it('preserves the version through lifecycle writes (archive/soft delete)', async () => {
    const { service } = createTestEnv();
    const created = await service.createMemory(
      makeCreateInput({
        type: MemoryType.Conversation,
        owner: makeOwner(MemoryOwnerKind.User, '1'),
      }),
    );
    const archiveActor = makeActor(MemoryActorGroup.MemoryManager, ['user:1']);
    const archived = await service.archiveMemory({
      actor: archiveActor,
      namespace: created.namespace,
      key: created.key,
      reason: 'archive',
    });
    expect(archived.version).toBe(created.version);
    const deleted = await service.deleteMemory({
      actor: archiveActor,
      namespace: created.namespace,
      key: created.key,
      reason: 'dsr',
    });
    expect(deleted.status).toBe('deleted');
  });
});
