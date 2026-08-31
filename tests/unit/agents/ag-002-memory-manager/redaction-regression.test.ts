import { describe, expect, it } from 'vitest';

import {
  MemoryActorGroup,
  MemoryPriority,
  MemorySecurityLevel,
  MemoryType,
} from '../../../../src/agents/ag-002-memory-manager/enums/index.js';
import type { AuthorizationService } from '../../../../src/agents/ag-002-memory-manager/security/index.js';
import {
  isSecretKeyName,
  redactSecrets,
} from '../../../../src/agents/ag-002-memory-manager/utils/sanitize.js';
import {
  sanitizeEvent,
  sanitizeEventMetadata,
} from '../../../../src/agents/ag-002-memory-manager/events/sanitize.js';
import { MemoryEventType } from '../../../../src/agents/ag-002-memory-manager/events/index.js';
import { createRetrievalService } from '../../../../src/agents/ag-002-memory-manager/services/retrieval.service.js';
import { InMemoryMemoryRepository } from '../../../../src/agents/ag-002-memory-manager/repositories/in-memory.js';
import { makeActor, makeRecord } from './fixtures.js';

/**
 * Sprint 12 — canonical redaction regression suite (Phase 4).
 *
 * Verifies the canonical `redactSecrets` handling of nested objects, deep
 * nesting, arrays, mixed casing, compound sensitive key names and non-mutation,
 * plus that retrieval snippets actually redact embedded secrets across the
 * required sensitive keys.
 */

const allowAllAuthorizer: AuthorizationService = {
  name: 'test-allow-all',
  authorize: () => ({ allowed: true }),
};

const SENSITIVE_VALUES = [
  'apiKey',
  'APIKEY',
  'api_key',
  'password',
  'Password',
  'userPassword',
  'accessToken',
  'refreshToken',
  'secret',
  'clientSecret',
  'credentials',
  'credential',
  'pwd',
  'passphrase',
];

describe('canonical redactSecrets - unit coverage', () => {
  it('nested secrets are redacted recursively', () => {
    const input = { user: { apiKey: 'sk-live-secret' }, safe: 'ok' };
    const out = redactSecrets(input) as Record<string, unknown>;
    expect((out.user as Record<string, unknown>).apiKey).toBe('[REDACTED]');
    expect(out.safe).toBe('ok');
  });

  it('redacts at depth >= 6', () => {
    const input = {
      a: { b: { c: { d: { e: { f: { password: 'hunter2' } } } } } },
    };
    const out = redactSecrets(input) as {
      a: { b: { c: { d: { e: { f: { password: string } } } } } };
    };
    expect(out.a.b.c.d.e.f.password).toBe('[REDACTED]');
  });

  it('redacts inside arrays', () => {
    const input = { list: [{ clientSecret: 's3cr3t' }, { name: 'public' }] };
    const out = redactSecrets(input) as { list: Array<Record<string, unknown>> };
    expect(out.list[0]!.clientSecret).toBe('[REDACTED]');
    expect(out.list[1]!.name).toBe('public');
  });

  it('handles mixed casing', () => {
    const out = redactSecrets({ API_KEY: 'v', ApiKey: 'v', apiKey: 'v' }) as Record<
      string,
      unknown
    >;
    expect(out.API_KEY).toBe('[REDACTED]');
    expect(out.ApiKey).toBe('[REDACTED]');
    expect(out.apiKey).toBe('[REDACTED]');
  });

  it('handles compound sensitive key names', () => {
    for (const key of SENSITIVE_VALUES) {
      expect(isSecretKeyName(key), `key ${key}`).toBe(true);
      const out = redactSecrets({ [key]: 'secret-value' }) as Record<string, unknown>;
      expect(out[key], `redact ${key}`).toBe('[REDACTED]');
    }
  });

  it('is non-mutating (returns a safe copy)', () => {
    const input = { apiKey: 'sk-live-xx', nested: { password: 'hunter2' } };
    const snapshot = JSON.stringify(input);
    redactSecrets(input);
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(input.apiKey).toBe('sk-live-xx');
  });

  it('redacts secret-looking bare string values', () => {
    expect(redactSecrets('Bearer abc123')).toBe('[REDACTED]');
    expect(redactSecrets('myAccessTokenHere')).toBe('[REDACTED]');
  });
});

describe('retrieval snippet redaction', () => {
  async function snippetFor(content: unknown): Promise<string> {
    const repo = new InMemoryMemoryRepository();
    const service = createRetrievalService({
      repository: repo,
      authorizationService: allowAllAuthorizer,
      clock: undefined,
      logger: undefined,
    });
    const actor = makeActor(MemoryActorGroup.Client, ['user:1'], {
      securityClearance: MemorySecurityLevel.Confidential,
    });
    await repo.create(
      makeRecord({
        namespace: 'user:1',
        key: 'k',
        type: MemoryType.User,
        priority: MemoryPriority.High,
        content: content as never,
      }),
    );
    const res = await service.retrieve({ actor, namespace: 'user:1', query: 'test' });
    return res.results[0]!.snippet ?? '';
  }

  const inlineCases: Array<[string, string, string]> = [
    ['apiKey', 'apiKey: sk-live-1234567890abcdef', 'sk-live'],
    ['api_key', 'api_key = abcdefghijklmno', 'abcdefghijklmno'],
    ['password', 'password: supersecret123', 'supersecret123'],
    ['clientSecret', 'clientSecret: very-secret-0001', 'very-secret'],
    ['pwd', 'pwd: hunter2', 'hunter2'],
    ['passphrase', 'passphrase = my-pass-phrase-1', 'my-pass-phrase-1'],
    ['credential', 'credential: abc123credential', 'credential'],
    ['token', 'token: abc123tokenxyz', 'token'],
  ];

  for (const [name, content, forbidden] of inlineCases) {
    it(`redacts inline ${name} from snippets`, async () => {
      const snippet = await snippetFor(content);
      expect(snippet.toLowerCase()).not.toContain(forbidden.toLowerCase());
    });
  }

  it('redacts secrets embedded in nested object content snippets', async () => {
    const snippet = await snippetFor({
      user: { profile: { name: 'Alice', apiKey: 'sk-live-aaa', auth: { pwd: 'hunter2' } } },
    });
    expect(snippet).not.toContain('sk-live-aaa');
    expect(snippet).not.toContain('hunter2');
  });

  it('redacts secrets inside arrays in object content snippets', async () => {
    const snippet = await snippetFor({ tokens: ['public', { accessToken: 'at-123456789' }] });
    expect(snippet).not.toContain('at-123456789');
  });
});

describe('event sanitization', () => {
  it('sanitizes nested/compound secret keys in event metadata non-mutatingly', () => {
    const metadata = {
      ok: 'public',
      config: { apiKey: 'sk-live-abc', refreshToken: 'rt-xyz', safe: 1 },
    };
    const out = sanitizeEventMetadata(metadata) as Record<string, unknown>;
    expect((out.config as Record<string, unknown>).apiKey).toBe('[REDACTED]');
    expect((out.config as Record<string, unknown>).refreshToken).toBe('[REDACTED]');
    expect((out.config as Record<string, unknown>).safe).toBe(1);
    expect(metadata.config.apiKey).toBe('sk-live-abc');
  });

  it('sanitizeEvent produces a sanitized non-mutating copy of the event', () => {
    const event = {
      eventId: `evt-1`,
      sequence: 1,
      traceId: 't',
      namespace: 'user:1',
      key: 'k',
      type: MemoryEventType.Created as MemoryEventType,
      occurredAt: '2026-01-01T00:00:00.000Z',
      actorGroup: MemoryActorGroup.Client,
      metadata: { password: 'hunter2', nested: { clientSecret: 'cs-x' } },
    };
    const out = sanitizeEvent(event);
    expect((out.metadata as Record<string, unknown>).password).toBe('[REDACTED]');
    expect(
      ((out.metadata as Record<string, unknown>).nested as Record<string, unknown>).clientSecret,
    ).toBe('[REDACTED]');
    // original untouched
    expect(event.metadata.password).toBe('hunter2');
  });
});
