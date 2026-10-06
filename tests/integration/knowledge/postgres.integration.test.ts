import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveTestDatabase } from '../../../src/lib/test-database-guard.js';

import {
  KnowledgeManagerService,
  PostgresKnowledgeRepository,
  KnowledgeContentType,
  KnowledgeLifecycleState,
  KnowledgeSecurityLevel,
  KnowledgeSourceType,
  KnowledgeActorGroup,
  KnowledgeConfigSchema,
  createKnowledgeEventLog,
  migrateKnowledgeSchema,
  KNOWLEDGE_SCHEMA_VERSION,
} from '../../../src/agents/ag-003-knowledge-manager/index.js';
import { createPostgresPool } from '../../../src/agents/ag-002-memory-manager/index.js';
import type pg from 'pg';

/**
 * AG-003 real PostgreSQL integration tests.
 *
 * Runs ONLY when the dedicated AIOS_TEST_DATABASE_URL is configured (an isolated
 * local test database; prompts13 Blocker 2 removed the production
 * MEMORY_DATABASE_URL fallback entirely). Exercises genuine durable knowledge
 * storage: schema migrations, CRUD across restart, version immutability, and
 * lifecycle transitions. Skipped when no isolated test database is configured.
 */

// Guarded (prompts13 Blocker 2): integration suites may only target an isolated
// local test database and never fall back to the production MEMORY_DATABASE_URL.
const testDb = resolveTestDatabase('AG-003 knowledge postgres integration suite');
const DATABASE_URL = testDb.url;

const suite = testDb.enabled ? describe : describe.skip;

const ns = `int-kn-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

const actor = { group: KnowledgeActorGroup.KnowledgeManager, actorId: 'km-int' };

suite('AG-003 - real PostgreSQL knowledge backend (integration)', () => {
  let pool: pg.Pool;
  let repo: PostgresKnowledgeRepository;
  let service: KnowledgeManagerService;

  beforeAll(async () => {
    pool = createPostgresPool(DATABASE_URL!);
    repo = new PostgresKnowledgeRepository({ pool });
    const applied = await migrateKnowledgeSchema(pool);
    expect(applied).toBeGreaterThanOrEqual(0);
    service = new KnowledgeManagerService({
      repository: repo,
      config: KnowledgeConfigSchema.parse({ KNOWLEDGE_STORAGE_BACKEND: 'durable' }),
      eventLog: createKnowledgeEventLog(),
    });
  }, 120000);

  afterAll(async () => {
    if (repo) {
      await repo.eraseByNamespace(ns).catch(() => undefined);
    }
    if (pool) {
      await pool.end().catch(() => undefined);
    }
  });

  describe('schema migrations', () => {
    it('are idempotent across repeated runs', async () => {
      const again = await migrateKnowledgeSchema(pool);
      expect(again).toBe(0);
      expect(KNOWLEDGE_SCHEMA_VERSION).toBeGreaterThanOrEqual(100);
    }, 30000);
  });

  describe('durable CRUD + restart durability', () => {
    it('creates a document and reloads it from a fresh connection', async () => {
      const doc = await service.createDocument({
        title: 'Durable onboarding guide',
        content: 'Verify client identity, then collect project requirements.',
        contentType: KnowledgeContentType.PlainText,
        namespace: ns,
        securityLevel: KnowledgeSecurityLevel.Internal,
        source: { sourceType: KnowledgeSourceType.System },
        actorGroup: actor.group,
        actorId: actor.actorId,
      });

      // Reload from a brand-new pool (simulates process restart)
      const fresh = new PostgresKnowledgeRepository({ pool: createPostgresPool(DATABASE_URL!) });
      const reloaded = await fresh.getById(doc.id);
      expect(reloaded?.title).toBe('Durable onboarding guide');
      expect(reloaded?.content).toContain('Verify client identity');
      expect(reloaded?.version).toBe(1);
      await fresh.close?.().catch(() => undefined);
    }, 30000);

    it('persists versions durably and keeps v1 immutable', async () => {
      const doc = await service.createDocument({
        title: 'Pricing guide v-d', // unique-ish title
        content: 'Base rate is $50 per hour.',
        contentType: KnowledgeContentType.PlainText,
        namespace: `${ns}-versions`,
        securityLevel: KnowledgeSecurityLevel.Internal,
        source: { sourceType: KnowledgeSourceType.System },
        actorGroup: actor.group,
        actorId: actor.actorId,
      });

      const result = await service.createVersion({
        documentId: doc.id,
        title: 'Pricing guide v-d',
        content: 'Base rate is $60 per hour with a minimum of 4 hours.',
        contentType: KnowledgeContentType.PlainText,
        securityLevel: KnowledgeSecurityLevel.Internal,
        source: { sourceType: KnowledgeSourceType.System },
        actorGroup: actor.group,
        actorId: actor.actorId,
      });
      expect(result.version.versionNumber).toBe(2);

      const v1 = await service.getVersion(doc.id, 1, actor.group, actor.actorId);
      expect(v1?.content).toBe('Base rate is $50 per hour.');
      await repo.eraseByNamespace(`${ns}-versions`);
    }, 30000);

    it('rejects duplicate titles in the same namespace', async () => {
      const title = 'Duplicate title check';
      await service.createDocument({
        title,
        content: 'First body.',
        contentType: KnowledgeContentType.PlainText,
        namespace: ns,
        securityLevel: KnowledgeSecurityLevel.Internal,
        source: { sourceType: KnowledgeSourceType.System },
        actorGroup: actor.group,
        actorId: actor.actorId,
      });
      await expect(
        service.createDocument({
          title,
          content: 'Second body.',
          contentType: KnowledgeContentType.PlainText,
          namespace: ns,
          securityLevel: KnowledgeSecurityLevel.Internal,
          source: { sourceType: KnowledgeSourceType.System },
          actorGroup: actor.group,
          actorId: actor.actorId,
        }),
      ).rejects.toThrow();
    }, 30000);
  });

  describe('durable lifecycle', () => {
    it('transitions ARCHIVED -> ACTIVE durably', async () => {
      const doc = await service.createDocument({
        title: 'Archiveable policy',
        content: 'Policy content that will be archived and restored.',
        contentType: KnowledgeContentType.PlainText,
        namespace: `${ns}-life`,
        securityLevel: KnowledgeSecurityLevel.Internal,
        source: { sourceType: KnowledgeSourceType.System },
        actorGroup: actor.group,
        actorId: actor.actorId,
      });

      await service.transitionLifecycle({
        documentId: doc.id,
        targetState: KnowledgeLifecycleState.Archived,
        actorGroup: actor.group,
        actorId: actor.actorId,
      });

      const archived = await service.getDocument(doc.id, actor.group, actor.actorId);
      expect(archived?.lifecycle).toBe(KnowledgeLifecycleState.Archived);

      await service.transitionLifecycle({
        documentId: doc.id,
        targetState: KnowledgeLifecycleState.Active,
        actorGroup: actor.group,
        actorId: actor.actorId,
      });

      const restored = await service.getDocument(doc.id, actor.group, actor.actorId);
      expect(restored?.lifecycle).toBe(KnowledgeLifecycleState.Active);
      await repo.eraseByNamespace(`${ns}-life`);
    }, 30000);
  });
});
