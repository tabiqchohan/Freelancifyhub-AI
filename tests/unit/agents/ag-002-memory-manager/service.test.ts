import { describe, expect, it } from 'vitest';

import {
  MemoryActorGroup,
  MemoryLifecycleState,
  MemoryOwnerKind,
  MemoryPriority,
  MemorySecurityLevel,
  MemoryType,
} from '../../../../src/agents/ag-002-memory-manager/enums/index.js';
import {
  MemoryAccessDeniedError,
  MemoryConfigurationError,
  MemoryConflictError,
  MemoryNotFoundError,
  MemoryValidationError,
} from '../../../../src/agents/ag-002-memory-manager/errors/index.js';
import { MemoryEventType } from '../../../../src/agents/ag-002-memory-manager/events/index.js';
import { createMemoryManagerService } from '../../../../src/agents/ag-002-memory-manager/services/memory.service.js';
import {
  adminActor,
  clientActor,
  createTestEnv,
  makeActor,
  makeCreateInput,
  makeOwner,
  makeRecord,
  memoryManagerActor,
} from './fixtures.js';

describe('MemoryManagerService - construction and DI (O)', () => {
  it('fails closed when a required dependency is missing', () => {
    expect(() =>
      createMemoryManagerService({} as unknown as Parameters<typeof createMemoryManagerService>[0]),
    ).toThrow(MemoryConfigurationError);
  });

  it('exposes stable contract metadata', () => {
    const { service } = createTestEnv();
    expect(service.name).toBe('memory-manager-service');
    expect(service.version).toBe('1.0.0');
  });

  it('coordinates injected engines instead of constructing its own', async () => {
    const { service, repository } = createTestEnv();
    const created = await service.createMemory(makeCreateInput());
    expect(created.version).toBe(1);
    expect(await repository.exists(created.namespace, created.key)).toBe(true);
  });
});

describe('MemoryManagerService - createMemory', () => {
  it('creates an active record with generated id and type defaults', async () => {
    const { service } = createTestEnv();
    const created = await service.createMemory(makeCreateInput());
    expect(created.id).toMatch(/^memory_/);
    expect(created.lifecycle).toBe(MemoryLifecycleState.Active);
    expect(created.version).toBe(1);
    expect(created.priority).toBe(MemoryPriority.Critical); // User default
    expect(created.securityLevel).toBe(MemorySecurityLevel.Confidential); // User default
    expect(created.retention.kind).toBe('until_deletion');
    expect(created.traceId).toMatch(/^trace_/);
  });

  it('applies conversation TTL defaults and computes expiresAt', async () => {
    const { service } = createTestEnv();
    const created = await service.createMemory(
      makeCreateInput({
        type: MemoryType.Conversation,
        owner: makeOwner(MemoryOwnerKind.User, '1'),
      }),
    );
    expect(created.ttlMs).toBe(30 * 24 * 60 * 60 * 1000);
    expect(created.expiresAt).toBeDefined();
    expect(created.priority).toBe(MemoryPriority.High);
  });

  it('honours an explicit TTL', async () => {
    const { service } = createTestEnv();
    const created = await service.createMemory(makeCreateInput({ ttlMs: 5000 }));
    expect(created.ttlMs).toBe(5000);
    expect(created.expiresAt).toBeDefined();
  });

  it('rejects a duplicate create with a conflict', async () => {
    const { service } = createTestEnv();
    await service.createMemory(makeCreateInput());
    await expect(service.createMemory(makeCreateInput())).rejects.toBeInstanceOf(
      MemoryConflictError,
    );
  });

  it('rejects content exceeding the configured limit', async () => {
    const { service } = createTestEnv();
    await expect(
      service.createMemory(makeCreateInput({ content: { big: 'x'.repeat(64 * 1024 + 1) } })),
    ).rejects.toBeInstanceOf(MemoryValidationError);
  });

  it('emits a MemoryCreated event with owner/namespace/key/type/version', async () => {
    const { service, events } = createTestEnv();
    const created = await service.createMemory(makeCreateInput());
    const event = events.list().find((e) => e.type === MemoryEventType.Created);
    expect(event).toBeDefined();
    expect(event).toMatchObject({
      namespace: created.namespace,
      key: created.key,
      version: 1,
      actorGroup: MemoryActorGroup.Client,
    });
  });
});

describe('MemoryManagerService - getMemory', () => {
  it('returns a stored record', async () => {
    const { service } = createTestEnv();
    const created = await service.createMemory(makeCreateInput());
    const loaded = await service.getMemory({
      actor: clientActor,
      namespace: created.namespace,
      key: created.key,
    });
    expect(loaded.content).toEqual({ theme: 'dark' });
  });

  it('throws not-found for a missing key', async () => {
    const { service } = createTestEnv();
    await expect(
      service.getMemory({ actor: clientActor, namespace: 'user:1', key: 'nope' }),
    ).rejects.toBeInstanceOf(MemoryNotFoundError);
  });

  it('throws not-found for an expired record (AC-MEM-4)', async () => {
    const { service, repository } = createTestEnv();
    await service.createMemory(makeCreateInput());
    const expired = makeRecord({
      namespace: 'user:1',
      key: 'expired_key',
      type: MemoryType.User,
      expiresAt: '2026-01-01T00:00:00.000Z',
    });
    await repository.create(expired);
    await expect(
      service.getMemory({ actor: clientActor, namespace: 'user:1', key: 'expired_key' }),
    ).rejects.toBeInstanceOf(MemoryNotFoundError);
  });

  it('throws not-found for a soft-deleted record', async () => {
    const { service } = createTestEnv();
    const created = await service.createMemory(
      makeCreateInput({
        type: MemoryType.Conversation,
        owner: makeOwner(MemoryOwnerKind.User, '1'),
      }),
    );
    await service.deleteMemory({
      actor: memoryManagerActor,
      namespace: created.namespace,
      key: created.key,
      reason: 'dsr',
    });
    await expect(
      service.getMemory({
        actor: memoryManagerActor,
        namespace: created.namespace,
        key: created.key,
      }),
    ).rejects.toBeInstanceOf(MemoryNotFoundError);
  });

  it('throws access-denied when the actor lacks read permission', async () => {
    const { service } = createTestEnv();
    const created = await service.createMemory(makeCreateInput());
    const outsider = makeActor(MemoryActorGroup.Marketplace, ['project:1']);
    await expect(
      service.getMemory({ actor: outsider, namespace: created.namespace, key: created.key }),
    ).rejects.toBeInstanceOf(MemoryAccessDeniedError);
  });
});

describe('MemoryManagerService - updateMemory', () => {
  it('applies content and metadata patches and bumps the version', async () => {
    const { service, events } = createTestEnv();
    const created = await service.createMemory(makeCreateInput());
    const updated = await service.updateMemory({
      actor: clientActor,
      namespace: created.namespace,
      key: created.key,
      expectedVersion: 1,
      reason: 'preference change',
      content: { theme: 'light' },
      metadata: { source: 'cli', flags: ['beta'] },
    });
    expect(updated.version).toBe(2);
    expect(updated.content).toEqual({ theme: 'light' });
    expect(updated.metadata).toEqual({ source: 'cli', flags: ['beta'] });
    expect(events.list().some((e) => e.type === MemoryEventType.Updated)).toBe(true);
  });

  it('rejects a stale expected version with a conflict', async () => {
    const { service } = createTestEnv();
    const created = await service.createMemory(makeCreateInput());
    await expect(
      service.updateMemory({
        actor: clientActor,
        namespace: created.namespace,
        key: created.key,
        expectedVersion: 99,
        reason: 'stale',
      }),
    ).rejects.toBeInstanceOf(MemoryConflictError);
  });
});

describe('MemoryManagerService - deleteMemory', () => {
  it('soft-deletes by default and emits a deleted event', async () => {
    const { service, events } = createTestEnv();
    const created = await service.createMemory(
      makeCreateInput({
        type: MemoryType.Conversation,
        owner: makeOwner(MemoryOwnerKind.User, '1'),
      }),
    );
    const result = await service.deleteMemory({
      actor: memoryManagerActor,
      namespace: created.namespace,
      key: created.key,
      reason: 'right to forget',
    });
    expect(result.status).toBe('deleted');
    const event = events.list().find((e) => e.type === MemoryEventType.Deleted);
    expect(event?.hard).toBe(false);
    expect(event?.reason).toBe('right to forget');
  });

  it('hard-deletes (purges) when requested', async () => {
    const { service, repository } = createTestEnv();
    const created = await service.createMemory(
      makeCreateInput({
        type: MemoryType.Conversation,
        owner: makeOwner(MemoryOwnerKind.User, '1'),
      }),
    );
    const result = await service.deleteMemory({
      actor: memoryManagerActor,
      namespace: created.namespace,
      key: created.key,
      reason: 'dsr purge',
      hard: true,
    });
    expect(result.status).toBe('purged');
    expect(await repository.exists(created.namespace, created.key)).toBe(false);
  });

  it('denies deletes to an actor without delete permission', async () => {
    const { service } = createTestEnv();
    const created = await service.createMemory(makeCreateInput());
    await expect(
      service.deleteMemory({
        actor: clientActor,
        namespace: created.namespace,
        key: created.key,
        reason: 'try',
      }),
    ).rejects.toBeInstanceOf(MemoryAccessDeniedError);
  });

  it('allows admin delete within its own scoped namespaces', async () => {
    const { service } = createTestEnv();
    const created = await service.createMemory(
      makeCreateInput({
        actor: adminActor,
        type: MemoryType.Organization,
        namespace: 'org:1',
        owner: makeOwner(MemoryOwnerKind.Organization, '1'),
      }),
    );
    const result = await service.deleteMemory({
      actor: adminActor,
      namespace: created.namespace,
      key: created.key,
      reason: 'org cleanup',
    });
    expect(result.status).toBe('deleted');
  });
});

describe('MemoryManagerService - archiveMemory', () => {
  it('moves a record to the archived lifecycle and emits an event', async () => {
    const { service, events } = createTestEnv();
    const created = await service.createMemory(
      makeCreateInput({
        type: MemoryType.Conversation,
        owner: makeOwner(MemoryOwnerKind.User, '1'),
      }),
    );
    const archived = await service.archiveMemory({
      actor: memoryManagerActor,
      namespace: created.namespace,
      key: created.key,
      reason: 'retention archive',
    });
    expect(archived.lifecycle).toBe(MemoryLifecycleState.Archived);
    expect(events.list().some((e) => e.type === MemoryEventType.Archived)).toBe(true);
  });

  it('denies archiving to an actor without delete-class permission', async () => {
    const { service } = createTestEnv();
    const created = await service.createMemory(makeCreateInput());
    await expect(
      service.archiveMemory({
        actor: clientActor,
        namespace: created.namespace,
        key: created.key,
        reason: 'try',
      }),
    ).rejects.toBeInstanceOf(MemoryAccessDeniedError);
  });
});

describe('MemoryManagerService - retrieveMemory', () => {
  it('returns only records within the actor allow-list (AC-MEM-2)', async () => {
    const { service } = createTestEnv();
    await service.createMemory(makeCreateInput());
    const results = await service.retrieveMemory({
      actor: clientActor,
      namespace: 'user:1',
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.record.key).toBe('pref_theme');
  });

  it('returns nothing when the actor has no scope', async () => {
    const { service } = createTestEnv();
    await service.createMemory(makeCreateInput());
    const outsider = makeActor(MemoryActorGroup.Client, ['user:99']);
    const results = await service.retrieveMemory({
      actor: outsider,
      namespace: 'user:1',
    });
    expect(results).toEqual([]);
  });

  it('honours filters and emits a retrieved event with a count', async () => {
    const { service, events } = createTestEnv();
    await service.createMemory(makeCreateInput());
    const results = await service.retrieveMemory({
      actor: clientActor,
      namespace: 'user:1',
      filters: { type: MemoryType.Conversation },
    });
    expect(results).toEqual([]);
    const event = events.list().find((e) => e.type === MemoryEventType.Retrieved);
    expect(event?.count).toBe(0);
  });

  it('respects the configured retrieval limit', async () => {
    const { service } = createTestEnv();
    for (let i = 0; i < 3; i += 1) {
      await service.createMemory(makeCreateInput({ key: `pref_theme_${i}` }));
    }
    const results = await service.retrieveMemory({
      actor: clientActor,
      namespace: 'user:1',
      limit: 2,
    });
    expect(results).toHaveLength(2);
  });

  it('rejects invalid retrieval limits', async () => {
    const { service } = createTestEnv();
    await expect(
      service.retrieveMemory({ actor: clientActor, namespace: 'user:1', limit: 0 }),
    ).rejects.toBeInstanceOf(MemoryValidationError);
  });

  it('requires read permission at the record level', async () => {
    const { service } = createTestEnv();
    await service.createMemory(makeCreateInput());
    // AG-002 has no READ on user memory (matrix grants write-only), so even
    // inside the allow-list scope the record is filtered out.
    const results = await service.retrieveMemory({
      actor: memoryManagerActor,
      namespace: 'user:1',
    });
    expect(results).toEqual([]);
  });
});

describe('MemoryManagerService - write authorization (spec §7)', () => {
  it('denies a write the matrix does not grant', async () => {
    const { service } = createTestEnv();
    await expect(
      service.createMemory(
        makeCreateInput({
          actor: makeActor(MemoryActorGroup.Orchestrator, ['user:1']),
          type: MemoryType.Conversation,
        }),
      ),
    ).rejects.toBeInstanceOf(MemoryAccessDeniedError);
  });

  it('grants AG-002 consent/retention writes to user memory only', async () => {
    const { service } = createTestEnv();
    const created = await service.createMemory(
      makeCreateInput({
        actor: memoryManagerActor,
        namespace: 'user:1',
        type: MemoryType.User,
        content: { consent: 'marketing' },
      }),
    );
    expect(created.content).toEqual({ consent: 'marketing' });
    expect(created.securityLevel).toBe(MemorySecurityLevel.Confidential);
  });

  it('rejects writes outside the actor allow-list', async () => {
    const { service } = createTestEnv();
    await expect(
      service.createMemory(
        makeCreateInput({
          actor: makeActor(MemoryActorGroup.Client, ['user:99']),
          namespace: 'user:1',
        }),
      ),
    ).rejects.toBeInstanceOf(MemoryAccessDeniedError);
  });
});

describe('MemoryManagerService - write metadata (AC-MEM-3)', () => {
  it('records owner + reason on every write', async () => {
    const { service } = createTestEnv();
    const created = await service.createMemory(makeCreateInput({ reason: 'consent update' }));
    expect(created.owner).toEqual(makeOwner(MemoryOwnerKind.User, '1'));
    expect(created.reason).toBe('consent update');
  });

  it('rejects writes without a reason', async () => {
    const { service } = createTestEnv();
    await expect(service.createMemory(makeCreateInput({ reason: '' }))).rejects.toBeInstanceOf(
      MemoryValidationError,
    );
  });
});
