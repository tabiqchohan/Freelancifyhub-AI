/**
 * Sprint 35 F-6 — idempotency registry actor-scoping regression.
 *
 * Before the fix the registry was keyed by the raw caller-supplied
 * `idempotencyKey` alone, globally. Two consequences:
 *
 *  1. Two different callers choosing the same key collided (availability /
 *     denial of service on an unrelated caller).
 *  2. A caller who guessed another caller's key got that caller's *response*
 *     replayed to them — a cross-caller response disclosure.
 *
 * Keys are now scoped to the identity established by the service boundary
 * (`AiosRequest.principalId`), never the caller-asserted `actor.actorId`.
 */
import { describe, expect, it, vi } from 'vitest';

import { AggregationStatus } from '../../../src/agents/ag-001-master-orchestrator/aggregation/index.js';
import { AiosErrorCode } from '../../../src/ai-operating-system/errors.js';
import { AiosGateway, idempotencyPrincipal } from '../../../src/ai-operating-system/gateway.js';
import {
  assertValidIdempotencyKey,
  AiosIdempotencyRegistry,
  MAX_IDEMPOTENCY_ENTRIES,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  UNSCOPED_IDEMPOTENCY_PRINCIPAL,
} from '../../../src/ai-operating-system/idempotency.js';
import { AiosMetrics } from '../../../src/ai-operating-system/metrics.js';
import type { AiosPipeline } from '../../../src/ai-operating-system/pipeline.js';
import { DEFAULT_AIOS_CONFIG } from '../../../src/ai-operating-system/config.js';
import {
  AiosStage,
  type AiosRequest,
  type AiosResponse,
} from '../../../src/ai-operating-system/types.js';
import type { AiosService } from '../../../src/ai-operating-system/service.js';
import type { UserRole } from '../../../src/agents/ag-001-master-orchestrator/intent/index.js';

function response(requestId: string, marker: string): AiosResponse {
  return {
    requestId,
    traceId: `trace-${requestId}`,
    status: AggregationStatus.Success,
    intent: 'project.create',
    response: marker,
    stages: [AiosStage.Completed],
    execution: {
      target: { kind: 'orchestrator' },
      route: {
        intentId: 'project.create',
        supportedAgents: ['AG-001'],
        confidence: 1,
        target: { kind: 'orchestrator' },
      },
      intent: { primary: {} } as never,
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:00:01.000Z',
      durationMs: 1000,
      agents: ['AG-001'],
    },
  };
}

function req(options: {
  requestId: string;
  idempotencyKey: string;
  principalId?: string;
  actorId: string;
}): AiosRequest {
  return {
    requestId: options.requestId,
    traceId: `trace-${options.requestId}`,
    input: { text: 'create project' },
    principalId: options.principalId,
    actor: {
      actorId: options.actorId,
      role: 'Freelancer' as UserRole,
      namespaces: [],
    },
    options: { idempotencyKey: options.idempotencyKey },
  };
}

function gatewayOver(pipeline: AiosPipeline): AiosGateway {
  const service = {
    lastResult: vi.fn(() => undefined),
    isActive: vi.fn(() => false),
    activeCount: vi.fn(() => 0),
    cancel: vi.fn(),
  } as unknown as AiosService;
  return new AiosGateway({
    config: DEFAULT_AIOS_CONFIG,
    pipeline,
    service,
    metrics: new AiosMetrics(),
  });
}

describe('Sprint 35 F-6 — idempotency is scoped to the authenticated principal', () => {
  it('does not collide when two different principals use the same key', () => {
    const registry = new AiosIdempotencyRegistry(60_000);
    expect(registry.claim('tenant-a', 'shared-key', 'req-a')).toEqual({ outcome: 'new' });
    // Regression: this used to be a conflict against an unrelated caller.
    expect(registry.claim('tenant-b', 'shared-key', 'req-b')).toEqual({ outcome: 'new' });
    expect(registry.entryCount()).toBe(2);
  });

  it('never replays another principal response for the same key', () => {
    const registry = new AiosIdempotencyRegistry(60_000);
    registry.claim('tenant-a', 'k', 'req-a');
    registry.complete('tenant-a', 'k', response('req-a', 'TENANT-A-SECRET'));

    const claim = registry.claim('tenant-b', 'k', 'req-b');
    expect(claim).toEqual({ outcome: 'new' });
    expect(JSON.stringify(claim)).not.toContain('TENANT-A-SECRET');

    registry.complete('tenant-b', 'k', response('req-b', 'TENANT-B-OWN'));

    const replayB = registry.claim('tenant-b', 'k', 'req-b');
    expect(replayB).toMatchObject({ outcome: 'replay' });
    expect(JSON.stringify(replayB)).toContain('TENANT-B-OWN');
    expect(JSON.stringify(replayB)).not.toContain('TENANT-A-SECRET');
  });

  it('still conflicts within one principal', () => {
    const registry = new AiosIdempotencyRegistry(60_000);
    expect(registry.claim('tenant-a', 'k', 'req-a')).toEqual({ outcome: 'new' });
    expect(registry.claim('tenant-a', 'k', 'req-b')).toEqual({
      outcome: 'conflict',
      existingRequestId: 'req-a',
    });
  });

  it('rejects an oversized idempotency key before it reaches the registry', () => {
    expect(() => assertValidIdempotencyKey('a'.repeat(MAX_IDEMPOTENCY_KEY_LENGTH))).not.toThrow();
    expect(() => assertValidIdempotencyKey('a'.repeat(MAX_IDEMPOTENCY_KEY_LENGTH + 1))).toThrow(
      expect.objectContaining({ code: AiosErrorCode.InvalidInput }),
    );
  });

  it('rejects control characters in an idempotency key', () => {
    expect(() => assertValidIdempotencyKey('k\u0000rm -rf /')).toThrow(
      expect.objectContaining({ code: AiosErrorCode.InvalidInput }),
    );
  });

  it('bounds the registry when callers supply unbounded distinct keys', () => {
    const registry = new AiosIdempotencyRegistry(600_000);
    for (let i = 0; i < MAX_IDEMPOTENCY_ENTRIES; i += 1) {
      expect(registry.claim('svc-1', `k-${i}`, `req-${i}`).outcome).toBe('new');
    }
    expect(registry.entryCount()).toBe(MAX_IDEMPOTENCY_ENTRIES);
    expect(() => registry.claim('svc-1', 'one-too-many', 'req-x')).toThrow(
      expect.objectContaining({ code: AiosErrorCode.IdempotencyConflict }),
    );
  });

  it('never keys the idempotency window on the caller-asserted actorId (F-2/F-6)', async () => {
    // The trusted principal, not the body `actorId`, decides the keyspace.
    expect(
      idempotencyPrincipal(
        req({ requestId: 'r1', idempotencyKey: 'k', principalId: 'svc-1', actorId: 'victim' }),
      ),
    ).toBe('svc-1');

    const first = response('r1', 'VICTIM-SECRET');
    const pipeline = { execute: vi.fn(async () => first) } as unknown as AiosPipeline;
    const gateway = gatewayOver(pipeline);

    await gateway.request(
      req({ requestId: 'r1', idempotencyKey: 'k', principalId: 'svc-1', actorId: 'victim' }),
    );

    // An attacker on the same authenticated principal who forges a *different*
    // actorId cannot move into a fresh scope to dodge the claim: the key is
    // already owned by this principal, so it is a conflict, not a replay of
    // anything and not a silent new request.
    await expect(
      gateway.request(
        req({ requestId: 'r2', idempotencyKey: 'k', principalId: 'svc-1', actorId: 'attacker' }),
      ),
    ).rejects.toMatchObject({ code: AiosErrorCode.IdempotencyConflict });

    // The genuine retry (same requestId) still replays.
    const replay = await gateway.request(
      req({ requestId: 'r1', idempotencyKey: 'k', principalId: 'svc-1', actorId: 'attacker' }),
    );
    expect(replay).toBe(first);
  });

  it('a different principal cannot replay another principal response (F-6 replay)', async () => {
    // The pipeline is per-principal; each principal's execution yields its own
    // response, exactly as two real callers would see.
    const victimPipeline = {
      execute: vi.fn(async () => response('r1', 'TENANT-A-SECRET')),
    } as unknown as AiosPipeline;
    const attackerPipeline = {
      execute: vi.fn(async () => response('r2', 'TENANT-B-OWN')),
    } as unknown as AiosPipeline;

    const victimGateway = gatewayOver(victimPipeline);
    const attackerGateway = gatewayOver(attackerPipeline);

    await victimGateway.request(
      req({ requestId: 'r1', idempotencyKey: 'k', principalId: 'tenant-a', actorId: 'a' }),
    );

    // The attacker guesses tenant-a's key and reuses tenant-a's requestId.
    // Before the fix this replayed the victim's cached response verbatim.
    const stolen = await attackerGateway.request(
      req({ requestId: 'r1', idempotencyKey: 'k', principalId: 'tenant-b', actorId: 'a' }),
    );
    expect(attackerPipeline.execute).toHaveBeenCalledOnce();
    expect(JSON.stringify(stolen)).not.toContain('TENANT-A-SECRET');
    expect(JSON.stringify(stolen)).toContain('TENANT-B-OWN');
  });

  it('falls back to one shared conservative scope when no principal is bound', () => {
    expect(idempotencyPrincipal(req({ requestId: 'r', idempotencyKey: 'k', actorId: 'a' }))).toBe(
      UNSCOPED_IDEMPOTENCY_PRINCIPAL,
    );
  });
});
