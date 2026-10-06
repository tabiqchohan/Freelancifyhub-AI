import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveTestDatabase } from '../../../src/lib/test-database-guard.js';

import {
  KnowledgeManagerService,
  PostgresKnowledgeRepository,
  KnowledgeContentType,
  KnowledgeSecurityLevel,
  KnowledgeSourceType,
  KnowledgeActorGroup,
  KnowledgeConfigSchema,
  createKnowledgeEventLog,
  migrateKnowledgeSchema,
  KNOWLEDGE_SCHEMA_MIGRATIONS,
} from '../../../src/agents/ag-003-knowledge-manager/index.js';
import { createPostgresPool } from '../../../src/agents/ag-002-memory-manager/index.js';
import type pg from 'pg';

/**
 * Sprint 36 launch verification — real PostgreSQL namespace ownership/membership.
 *
 * Sprint 35 F-1 introduced `knowledge_namespace_access` (migration 104) but the
 * regression suite only exercised the in-memory repository, so the SQL itself
 * (atomic claim, membership, cross-namespace isolation) was never proven against
 * a real database. This suite runs ONLY when the dedicated
 * AIOS_TEST_DATABASE_URL is configured and closes that gap against genuine SQL
 * execution.
 */

// Guarded (prompts13 Blocker 2): integration suites may only target an isolated
// local test database and never fall back to the production MEMORY_DATABASE_URL.
const testDb = resolveTestDatabase('knowledge namespace-isolation integration suite');
const DATABASE_URL = testDb.url;

const suite = testDb.enabled ? describe : describe.skip;

const runId = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const claimedNs = `s36-claim-${runId}`;
const memberNs = `s36-member-${runId}`;
const ghostNs = `s36-ghost-${runId}`;
const isolatedNs = `s36-isolated-${runId}`;
const svcNs = `s36-svc-${runId}`;
const allNs = [claimedNs, memberNs, ghostNs, isolatedNs, svcNs];

suite('Sprint 36 - AG-003 namespace ownership on real PostgreSQL (integration)', () => {
  let pool: pg.Pool;
  let repo: PostgresKnowledgeRepository;

  beforeAll(async () => {
    pool = createPostgresPool(DATABASE_URL!);
    repo = new PostgresKnowledgeRepository({ pool });
    await migrateKnowledgeSchema(pool);
  }, 120000);

  afterAll(async () => {
    if (pool) {
      await pool
        .query('DELETE FROM knowledge_namespace_access WHERE namespace = ANY($1::text[])', [allNs])
        .catch(() => undefined);
      await pool.end().catch(() => undefined);
    }
  });

  describe('migration 104', () => {
    it('declares migration 104 in the shipped migration list', () => {
      const versions = KNOWLEDGE_SCHEMA_MIGRATIONS.map((m) => m.version);
      expect(versions).toContain(104);
      expect(versions).toEqual([...versions].sort((a, b) => a - b));
    });

    it('materializes knowledge_namespace_access with a non-empty owner constraint', async () => {
      const cols = await pool.query<{ column_name: string; is_nullable: string }>(
        `SELECT column_name, is_nullable FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'knowledge_namespace_access'`,
      );
      const names = cols.rows.map((c) => c.column_name);
      expect(names).toEqual(
        expect.arrayContaining([
          'namespace',
          'owner_actor_id',
          'member_actor_ids',
          'created_at',
          'updated_at',
        ]),
      );
      const owner = cols.rows.find((c) => c.column_name === 'owner_actor_id');
      expect(owner?.is_nullable).toBe('NO');

      // The DB-level CHECK is the last line of defence against an empty owner
      // sneaking in through a non-service code path.
      await expect(
        pool.query(
          `INSERT INTO knowledge_namespace_access
             (namespace, owner_actor_id, member_actor_ids, created_at, updated_at)
           VALUES ($1, '', '[]'::jsonb, NOW(), NOW())`,
          [`s36-check-${runId}`],
        ),
      ).rejects.toThrow(/knowledge_namespace_owner_valid/);
    }, 30000);
  });

  describe('atomic first-owner claim', () => {
    it('grants ownership to exactly one of many concurrent claimers', async () => {
      const contenders = Array.from({ length: 8 }, (_, i) => `racer-${i}`);
      const results = await Promise.all(
        contenders.map((actorId) =>
          repo.claimNamespace(claimedNs, actorId, new Date().toISOString()),
        ),
      );

      const winners = results.filter((r) => r.claimed);
      expect(winners).toHaveLength(1);
      const winner = winners[0]!;

      // Every loser must still observe the single winner as the owner.
      const stored = await repo.getNamespaceRecord(claimedNs);
      expect(stored).toBeDefined();
      expect(stored!.ownerActorId).toBe(winner.record.ownerActorId);
      expect(contenders).toContain(stored!.ownerActorId);
      for (const result of results) {
        expect(result.record.ownerActorId).toBe(stored!.ownerActorId);
      }
    }, 60000);

    it('refuses to let a second actor take over an owned namespace', async () => {
      const before = await repo.getNamespaceRecord(claimedNs);
      const takeover = await repo.claimNamespace(claimedNs, 'attacker', new Date().toISOString());

      expect(takeover.claimed).toBe(false);
      expect(takeover.record.ownerActorId).toBe(before!.ownerActorId);

      const after = await repo.getNamespaceRecord(claimedNs);
      expect(after!.ownerActorId).toBe(before!.ownerActorId);
      expect(after!.updatedAt).toBe(before!.updatedAt);
    }, 30000);

    it('starts a namespace unclaimed (no implicit/self-granted access row)', async () => {
      expect(await repo.getNamespaceRecord(isolatedNs)).toBeUndefined();
    });
  });

  describe('membership', () => {
    it('grants membership without transferring ownership', async () => {
      const claimed = await repo.claimNamespace(memberNs, 'owner-1', new Date().toISOString());
      expect(claimed.claimed).toBe(true);

      expect(await repo.addNamespaceMember(memberNs, 'member-1', new Date().toISOString())).toBe(
        true,
      );
      expect(await repo.addNamespaceMember(memberNs, 'member-2', new Date().toISOString())).toBe(
        true,
      );

      const stored = await repo.getNamespaceRecord(memberNs);
      expect(stored!.ownerActorId).toBe('owner-1');
      expect(stored!.memberActorIds).toEqual(expect.arrayContaining(['member-1', 'member-2']));
      expect(stored!.memberActorIds).not.toContain('owner-1');
    }, 30000);

    it('is idempotent and never duplicates an actor', async () => {
      const before = await repo.getNamespaceRecord(memberNs);
      expect(await repo.addNamespaceMember(memberNs, 'member-1', new Date().toISOString())).toBe(
        true,
      );
      const after = await repo.getNamespaceRecord(memberNs);

      expect(after!.memberActorIds.filter((a) => a === 'member-1')).toHaveLength(1);
      expect(after!.memberActorIds.length).toBe(before!.memberActorIds.length);
    }, 30000);

    it('keeps concurrent membership grants without losing any actor', async () => {
      const actors = Array.from({ length: 6 }, (_, i) => `bulk-${i}`);
      const granted = await Promise.all(
        actors.map((actorId) =>
          repo.addNamespaceMember(memberNs, actorId, new Date().toISOString()),
        ),
      );
      expect(granted.every(Boolean)).toBe(true);

      const stored = await repo.getNamespaceRecord(memberNs);
      for (const actorId of actors) {
        expect(stored!.memberActorIds).toContain(actorId);
      }
      expect(stored!.ownerActorId).toBe('owner-1');
    }, 60000);

    it('cannot materialize a namespace that nobody claimed', async () => {
      expect(await repo.addNamespaceMember(ghostNs, 'sneaky', new Date().toISOString())).toBe(
        false,
      );
      expect(await repo.getNamespaceRecord(ghostNs)).toBeUndefined();
    }, 30000);
  });

  describe('durability across connections', () => {
    it('reads ownership and membership back from a brand new connection', async () => {
      const freshPool = createPostgresPool(DATABASE_URL!);
      try {
        const freshRepo = new PostgresKnowledgeRepository({ pool: freshPool });
        const record = await freshRepo.getNamespaceRecord(memberNs);

        expect(record).toBeDefined();
        expect(record!.ownerActorId).toBe('owner-1');
        expect(record!.memberActorIds).toEqual(
          expect.arrayContaining(['member-1', 'member-2', 'bulk-5']),
        );
      } finally {
        await freshPool.end().catch(() => undefined);
      }
    }, 60000);

    it('keeps namespaces isolated from each other', async () => {
      await repo.claimNamespace(isolatedNs, 'iso-owner', new Date().toISOString());
      await repo.addNamespaceMember(isolatedNs, 'iso-member', new Date().toISOString());

      const isolated = await repo.getNamespaceRecord(isolatedNs);
      const other = await repo.getNamespaceRecord(memberNs);

      expect(isolated!.ownerActorId).toBe('iso-owner');
      expect(isolated!.memberActorIds).toEqual(['iso-member']);
      expect(other!.memberActorIds).not.toContain('iso-member');
      expect(other!.memberActorIds).not.toContain('iso-owner');
    }, 30000);
  });

  describe('service-level authorization against PostgreSQL storage', () => {
    it('lets only the persisted owner and members reach documents in the namespace', async () => {
      const service = new KnowledgeManagerService({
        repository: repo,
        config: KnowledgeConfigSchema.parse({ KNOWLEDGE_STORAGE_BACKEND: 'durable' }),
        eventLog: createKnowledgeEventLog(),
      });

      const ownerGroup = KnowledgeActorGroup.KnowledgeManager;
      const ownerId = 'svc-owner';
      const strangerId = 'svc-stranger';

      const created = await service.createDocument({
        title: 'Sprint 36 namespace isolation',
        content: 'Only the persisted owner and explicit members may read this.',
        contentType: KnowledgeContentType.PlainText,
        namespace: svcNs,
        securityLevel: KnowledgeSecurityLevel.Internal,
        source: { sourceType: KnowledgeSourceType.System },
        actorGroup: ownerGroup,
        actorId: ownerId,
      });

      // The owner legitimately claimed the namespace, so its own read succeeds.
      const ownerRead = await service.getDocument(created.id, ownerGroup, ownerId);
      expect(ownerRead?.id).toBe(created.id);

      // A stranger cannot claim an owned namespace, so it can never authorize.
      const strangerClaim = await repo.claimNamespace(svcNs, strangerId, new Date().toISOString());
      expect(strangerClaim.claimed).toBe(false);

      await expect(service.getDocument(created.id, ownerGroup, strangerId)).rejects.toThrow();

      // An explicit member is authorized even though it is not the owner.
      await repo.addNamespaceMember(svcNs, 'svc-member', new Date().toISOString());
      const memberRead = await service.getDocument(created.id, ownerGroup, 'svc-member');
      expect(memberRead?.id).toBe(created.id);
    }, 60000);
  });
});
