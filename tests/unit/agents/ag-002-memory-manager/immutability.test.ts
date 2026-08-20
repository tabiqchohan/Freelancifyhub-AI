import { describe, expect, it } from 'vitest';

import {
  MemoryActorGroup,
  MemoryLifecycleState,
  MemoryOwnerKind,
  MemoryType,
} from '../../../../src/agents/ag-002-memory-manager/enums/index.js';
import { serializeMemoryRecord } from '../../../../src/agents/ag-002-memory-manager/utils/serialization.js';
import {
  validateMemoryRecord,
  validateMemoryContent,
} from '../../../../src/agents/ag-002-memory-manager/validators/index.js';
import { createTestEnv, makeActor, makeCreateInput, makeOwner, makeRecord } from './fixtures.js';

describe('immutability - inputs are never mutated (prompt §19)', () => {
  it('createMemory does not mutate the input object', async () => {
    const { service } = createTestEnv();
    const input = makeCreateInput({ content: { theme: 'dark', tags: ['a'] } });
    const snapshot = JSON.stringify(input);
    await service.createMemory(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('updateMemory does not mutate the input object', async () => {
    const { service } = createTestEnv();
    const created = await service.createMemory(makeCreateInput());
    const input = {
      actor: makeCreateInput().actor,
      namespace: created.namespace,
      key: created.key,
      expectedVersion: created.version,
      reason: 'change preference',
      content: { theme: 'light' },
    };
    const snapshot = JSON.stringify(input);
    await service.updateMemory(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('validation does not mutate the input record', () => {
    const record = makeRecord({ metadata: { a: 1 } });
    const snapshot = JSON.stringify(record);
    validateMemoryRecord(record);
    expect(JSON.stringify(record)).toBe(snapshot);
  });

  it('serialization does not mutate the input record', () => {
    const record = makeRecord({ content: { nested: { deep: [1, 2] } } });
    const snapshot = JSON.stringify(record);
    serializeMemoryRecord(record);
    expect(JSON.stringify(record)).toBe(snapshot);
  });

  it('content validation does not mutate the input content', () => {
    const content = { list: [{ id: 1 }, { id: 2 }] };
    const snapshot = JSON.stringify(content);
    validateMemoryContent(content);
    expect(JSON.stringify(content)).toBe(snapshot);
  });

  it('the returned record is independent of the input content reference', async () => {
    const { service } = createTestEnv();
    const content = { theme: 'dark' };
    const created = await service.createMemory(makeCreateInput({ content }));
    (content as { theme: string }).theme = 'MUTATED';
    expect((created.content as { theme: string }).theme).toBe('dark');
  });

  it('mutating a retrieved record does not corrupt the store', async () => {
    const { service } = createTestEnv();
    const created = await service.createMemory(makeCreateInput());
    const read = await service.getMemory({
      actor: makeCreateInput().actor,
      namespace: created.namespace,
      key: created.key,
    });
    (read.content as { theme: string }).theme = 'HACKED';
    const readAgain = await service.getMemory({
      actor: makeCreateInput().actor,
      namespace: created.namespace,
      key: created.key,
    });
    expect((readAgain.content as { theme: string }).theme).toBe('dark');
  });

  it('lifecycle writes preserve all prior record attributes', async () => {
    const { service } = createTestEnv();
    const created = await service.createMemory(
      makeCreateInput({
        type: MemoryType.Conversation,
        content: { theme: 'dark' },
        metadata: { source: 'cli' },
        owner: makeOwner(MemoryOwnerKind.User, '1'),
      }),
    );
    const archived = await service.archiveMemory({
      actor: makeActor(MemoryActorGroup.MemoryManager, ['user:1']),
      namespace: created.namespace,
      key: created.key,
      reason: 'archive',
    });
    expect(archived.content).toEqual({ theme: 'dark' });
    expect(archived.metadata).toEqual({ source: 'cli' });
    expect(archived.owner).toEqual(makeOwner(MemoryOwnerKind.User, '1'));
    expect(archived.lifecycle).toBe(MemoryLifecycleState.Archived);
  });
});
