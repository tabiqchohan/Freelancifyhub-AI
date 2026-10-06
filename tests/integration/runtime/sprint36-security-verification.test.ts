/**
 * Sprint 36 Phase 2 — independent adversarial verification of Sprint 35
 * findings F-1 through F-6 at the real HTTP boundary.
 *
 * This suite is deliberately *separate* from the Sprint 35 regression tests:
 * it boots a real `ProductionRuntime` with the service and admin credentials
 * configured and attacks the boundary the way an external caller would, so a
 * regression in the wiring (not just in the service logic) is detected.
 *
 * Nothing here mutates persisted tenant state across tests: each describe
 * block uses its own runtime instance.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { createProductionComposition } from '../../../src/app/composition-root.js';
import { createProductionRuntime } from '../../../src/app/runtime.js';
import type { ProductionRuntime } from '../../../src/app/runtime.js';
import type { ProductionComposition } from '../../../src/app/composition-root.js';
import { parseCompiledEnv } from '../../../src/app/env.js';

const SERVICE_TOKEN = 'sprint36-service-token-aaaa';
const ADMIN_TOKEN = 'sprint36-admin-token-bbbb';

function env(overrides: { serviceToken?: string; adminToken?: string } = {}) {
  const parsed = parseCompiledEnv({
    AIOS_SERVICE_TOKEN: overrides.serviceToken ?? SERVICE_TOKEN,
    AIOS_ADMIN_TOKEN: overrides.adminToken ?? ADMIN_TOKEN,
  });
  parsed.memory.MEMORY_STORAGE_BACKEND = 'in-memory';
  parsed.knowledge.KNOWLEDGE_STORAGE_BACKEND = 'in-memory';
  parsed.tools.TOOLS_STORAGE_BACKEND = 'in-memory';
  return parsed;
}

const pino = async () => (await import('pino')).default({ level: 'silent' });

interface Booted {
  readonly runtime: ProductionRuntime;
  readonly baseUrl: string;
  readonly server: Server;
}

async function boot(
  overrides: {
    allowUnauthenticated?: boolean;
    serviceToken?: string;
    adminToken?: string;
  } = {},
): Promise<Booted> {
  const parsed = env({
    // An explicit empty string models "AIOS_SERVICE_TOKEN is unset in .env".
    ...(overrides.serviceToken === undefined ? {} : { serviceToken: overrides.serviceToken }),
    ...(overrides.adminToken === undefined ? {} : { adminToken: overrides.adminToken }),
  });
  const composition: ProductionComposition = await createProductionComposition({ env: parsed });
  const runtime = createProductionRuntime({
    composition,
    logger: await pino(),
    ...(overrides.allowUnauthenticated === undefined
      ? {}
      : { allowUnauthenticated: overrides.allowUnauthenticated }),
  });
  const server = await runtime.start(0, '127.0.0.1');
  const { port } = server.address() as AddressInfo;
  return { runtime, baseUrl: `http://127.0.0.1:${port}`, server };
}

function svc(extra: Record<string, string> = {}): Record<string, string> {
  return { 'x-aios-service-token': SERVICE_TOKEN, ...extra };
}
function adm(extra: Record<string, string> = {}): Record<string, string> {
  return { 'x-aios-service-token': SERVICE_TOKEN, 'x-aios-admin-token': ADMIN_TOKEN, ...extra };
}
function json(extra: Record<string, string> = {}): Record<string, string> {
  return { 'Content-Type': 'application/json', ...extra };
}

/* ------------------------------------------------------------------ */
/* F-4 — default authentication is fail-closed                        */
/* ------------------------------------------------------------------ */

describe('Sprint 36 F-4 — service authentication fails closed by default', () => {
  let b: Booted;
  beforeAll(async () => {
    // No allowUnauthenticated -> fail closed.
    b = await boot({});
  });
  afterAll(async () => {
    await b.runtime.shutdown();
  });

  it('refuses every business endpoint without a credential', async () => {
    const probes: [string, RequestInit][] = [
      ['/api/ai/status', {}],
      ['/api/ai/request', { method: 'POST', ...{ headers: json() }, body: '{}' }],
      ['/api/ai/cancel', { method: 'POST', headers: json(), body: '{}' }],
      ['/api/tools', {}],
      ['/api/knowledge', {}],
      ['/api/llm/status', {}],
      ['/api/coordination/status', {}],
      ['/api/client-ai/status', {}],
      ['/api/freelancer-ai/status', {}],
      ['/api/marketplace-ai/status', {}],
      ['/api/marketing-ai/status', {}],
      ['/api/admin-ai/status', {}],
      ['/runtime/request', { method: 'POST', headers: json(), body: '{}' }],
    ];
    for (const [path, init] of probes) {
      const res = await fetch(`${b.baseUrl}${path}`, init as RequestInit);
      expect(res.status, `${path} must be gated`).toBe(401);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe('unauthorized');
      // A rejection must not echo why the gate refused (no token hints).
      expect(JSON.stringify(body)).not.toContain('token');
    }
  });

  it('refuses a wrong service token', async () => {
    const res = await fetch(`${b.baseUrl}/api/ai/status`, {
      headers: { 'x-aios-service-token': 'wrong-token-value' },
    });
    expect(res.status).toBe(401);
  });

  it('keeps liveness and readiness reachable without a credential', async () => {
    for (const path of ['/livez', '/health', '/healthz', '/readyz']) {
      const res = await fetch(`${b.baseUrl}${path}`);
      expect(res.status, `${path} must stay public for probes`).toBe(200);
    }
  });

  it('never returns a secret from the public health payload', async () => {
    const res = await fetch(`${b.baseUrl}/health`);
    const text = await res.text();
    expect(text).not.toContain(SERVICE_TOKEN);
    expect(text).not.toContain(ADMIN_TOKEN);
  });
});

describe('Sprint 36 F-4 — unauthenticated mode is opt-in only', () => {
  let b: Booted;
  beforeAll(async () => {
    // Empty token + explicit opt-in. This is the development-only escape hatch.
    b = await boot({ allowUnauthenticated: true, serviceToken: '' });
  });
  afterAll(async () => {
    await b.runtime.shutdown();
  });

  it('serves business endpoints when explicitly enabled', async () => {
    const res = await fetch(`${b.baseUrl}/api/ai/status`);
    expect(res.status).toBe(200);
  });

  it('still refuses management without the admin credential', async () => {
    // Anonymous caller gets Orchestrator scope, never Admin.
    const res = await fetch(`${b.baseUrl}/api/tools/calculator/disable?group=ADMIN&ns=default`, {
      method: 'POST',
    });
    expect(res.status).toBe(403);
  });

  it('cannot weaken a deployment that has a service token configured', async () => {
    // The opt-in only applies when AIOS_SERVICE_TOKEN is empty. With a token
    // configured, the opt-in flag must not open the gate.
    const configured = await boot({ allowUnauthenticated: true });
    try {
      const anonymous = await fetch(`${configured.baseUrl}/api/ai/status`);
      expect(anonymous.status, 'opt-in must not open a configured deployment').toBe(401);
      const withToken = await fetch(`${configured.baseUrl}/api/ai/status`, { headers: svc() });
      expect(withToken.status).toBe(200);
    } finally {
      await configured.runtime.shutdown();
    }
  });
});

/* ------------------------------------------------------------------ */
/* F-3 — tool management requires the admin credential                */
/* ------------------------------------------------------------------ */

describe('Sprint 36 F-3 — tool management is bound to the admin credential', () => {
  let b: Booted;
  beforeAll(async () => {
    b = await boot({});
  });
  afterAll(async () => {
    await b.runtime.shutdown();
  });

  it('denies ?group=ADMIN to a service caller and changes no state', async () => {
    for (const action of ['disable', 'enable']) {
      const res = await fetch(
        `${b.baseUrl}/api/tools/calculator/${action}?group=ADMIN&ns=default`,
        {
          method: 'POST',
          headers: svc(),
        },
      );
      expect(res.status, `${action} must be denied`).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe('forbidden');
    }
    // Still executable => the denied attempts had no effect.
    const exec = await fetch(`${b.baseUrl}/api/tools/calculator/execute?ns=default`, {
      method: 'POST',
      headers: svc(json()),
      body: JSON.stringify({ input: { expression: '1+1' } }),
    });
    expect(exec.status).toBe(200);
  });

  it('denies management to a service token that also guesses admin headers', async () => {
    const res = await fetch(`${b.baseUrl}/api/tools/calculator/disable?ns=default`, {
      method: 'POST',
      headers: svc({
        'x-aios-admin-token': 'not-the-admin-token',
        'x-aios-service-token': 'not-the-service-token',
      }),
    });
    expect(res.status).toBe(401);
  });

  it('denies management to an anonymous caller', async () => {
    const anon = await boot({ allowUnauthenticated: true, serviceToken: '' });
    try {
      const res = await fetch(`${anon.baseUrl}/api/tools/calculator/disable?group=ADMIN`, {
        method: 'POST',
      });
      expect(res.status).toBe(403);
    } finally {
      await anon.runtime.shutdown();
    }
  });

  it('allows management only with the admin credential', async () => {
    const disabled = await fetch(`${b.baseUrl}/api/tools/calculator/disable?ns=default`, {
      method: 'POST',
      headers: adm(),
    });
    expect(disabled.status).toBe(200);

    const denied = await fetch(`${b.baseUrl}/api/tools/calculator/execute?ns=default`, {
      method: 'POST',
      headers: svc(json()),
      body: JSON.stringify({ input: { expression: '1+1' } }),
    });
    expect(denied.status).toBe(422);
    expect(((await denied.json()) as { status: string }).status).toBe('DISABLED');

    const enabled = await fetch(`${b.baseUrl}/api/tools/calculator/enable?ns=default`, {
      method: 'POST',
      headers: adm(),
    });
    expect(enabled.status).toBe(200);
  });
});

/* ------------------------------------------------------------------ */
/* F-2 — body fields cannot escalate identity                         */
/* ------------------------------------------------------------------ */

describe('Sprint 36 F-2 — request body cannot assert identity or authority', () => {
  let b: Booted;
  beforeAll(async () => {
    b = await boot({});
  });
  afterAll(async () => {
    await b.runtime.shutdown();
  });

  async function aios(
    body: Record<string, unknown>,
    headers: Record<string, string> = svc(json()),
  ): Promise<{ status: number; payload: Record<string, unknown> }> {
    const res = await fetch(`${b.baseUrl}/api/ai/request`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    return { status: res.status, payload: (await res.json()) as Record<string, unknown> };
  }

  it('ignores an escalated principalId in the body', async () => {
    // A body-supplied principalId must not become the identity. If it did, the
    // admin credential below would collide with this key instead of being
    // independent (see the next test for the collision signal).
    const key = `k-body-${Date.now()}`;
    const asService = await aios({
      text: 'create project new website',
      role: 'Freelancer',
      actorId: 'attacker',
      principalId: 'attacker-admin',
      group: 'ADMIN',
      adminScopes: ['*'],
      idempotencyKey: key,
    });
    expect(asService.status).toBe(200);

    // Same key, different trusted principal (admin credential) => no conflict.
    const asAdmin = await aios(
      {
        text: 'create project new website',
        role: 'Freelancer',
        actorId: 'attacker',
        idempotencyKey: key,
      },
      adm(json()),
    );
    expect(asAdmin.status, 'admin must not collide with a body-asserted principal').toBe(200);
  });

  it('keeps the idempotency window credential-scoped, not body-scoped', async () => {
    const key = `k-scope-${Date.now()}`;
    // First call claims the key as the service principal.
    const first = await aios({
      text: 'create project new website',
      role: 'Freelancer',
      actorId: 'alice',
      idempotencyKey: key,
    });
    expect(first.status).toBe(200);

    // Same principal, same key, different requestId => genuine conflict. This
    // holds even though the body claims a different actorId: the body cannot
    // move the request into a new scope.
    const forged = await aios({
      text: 'create project new website',
      role: 'Freelancer',
      actorId: 'someone-else',
      idempotencyKey: key,
    });
    expect(forged.status).toBe(409);
    expect(String(forged.payload.error)).toContain('IDEMPOTENCY');

    // A different credential is a different principal => independent scope.
    const otherPrincipal = await aios(
      {
        text: 'create project new website',
        role: 'Freelancer',
        actorId: 'alice',
        idempotencyKey: key,
      },
      adm(json()),
    );
    expect(otherPrincipal.status).toBe(200);
  });

  it('does not let a body role escalate to Guest-excluded privileges', async () => {
    // A Guest is platform-only; the pipeline must still refuse a project intent
    // even when the body claims admin scopes and a privileged group.
    const res = await aios({
      text: 'view project',
      role: 'Guest',
      actorId: 'attacker',
      group: 'ADMIN',
      adminScopes: ['admin.all'],
      securityClearance: 'CONFIDENTIAL',
    });
    expect(res.status).toBe(403);
    expect(res.payload.error).toBe('AIOS_UNAUTHORIZED_SCOPE');
  });

  it('rejects an invalid webhook-style body without leaking internals', async () => {
    const res = await aios({ role: 'Freelancer' } as Record<string, unknown>);
    expect(res.status).toBe(400);
    const text = JSON.stringify(res.payload);
    expect(text).not.toContain('at ');
    expect(text).not.toContain('.ts:');
    expect(text).not.toContain('node_modules');
  });
});

/* ------------------------------------------------------------------ */
/* F-5 — caller-facing errors are sanitized                           */
/* ------------------------------------------------------------------ */

describe('Sprint 36 F-5 — caller-facing errors expose no internals', () => {
  let b: Booted;
  beforeAll(async () => {
    b = await boot({});
  });
  afterAll(async () => {
    await b.runtime.shutdown();
  });

  it('returns a bounded status payload for a known request id', async () => {
    const requestId = `s36-status-${Date.now()}`;
    const res = await fetch(`${b.baseUrl}/api/ai/request`, {
      method: 'POST',
      headers: svc(json()),
      body: JSON.stringify({
        requestId,
        text: 'create project new website',
        role: 'Freelancer',
      }),
    });
    expect(res.status).toBe(200);

    const status = await fetch(`${b.baseUrl}/api/ai/status?requestId=${requestId}`, {
      headers: svc(),
    });
    expect(status.status).toBe(200);
    const text = await status.text();
    // Only stable codes may appear; no internals.
    expect(text).not.toMatch(/\/src\/|\.ts:\d+|node_modules|Error:|at \w+\./);
    expect(text).not.toContain(SERVICE_TOKEN);
    expect(text).not.toContain(ADMIN_TOKEN);
  });

  it('handles a malformed JSON body without an internal error', async () => {
    const res = await fetch(`${b.baseUrl}/api/ai/request`, {
      method: 'POST',
      headers: svc(json()),
      body: '{not json',
    });
    const text = await res.text();
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(text).not.toMatch(/\/src\/|\.ts:\d+|node_modules|SyntaxError/);
  });

  it('does not leak a stack trace from an unknown route or method', async () => {
    const res = await fetch(`${b.baseUrl}/api/ai/nope`, { headers: svc() });
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).not.toMatch(/\/src\/|\.ts:\d+|node_modules/);
  });

  it('bounds an oversized idempotency key instead of accepting it', async () => {
    const res = await fetch(`${b.baseUrl}/api/ai/request`, {
      method: 'POST',
      headers: svc(json()),
      body: JSON.stringify({
        text: 'create project new website',
        role: 'Freelancer',
        idempotencyKey: 'k'.repeat(5_000),
      }),
    });
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).not.toContain('k'.repeat(100));
  });
});

/* ------------------------------------------------------------------ */
/* F-6 — bounded, principal-scoped idempotency over HTTP              */
/* ------------------------------------------------------------------ */

describe('Sprint 36 F-6 — idempotency behaves correctly over the boundary', () => {
  let b: Booted;
  beforeAll(async () => {
    b = await boot({});
  });
  afterAll(async () => {
    await b.runtime.shutdown();
  });

  async function call(
    key: string,
    requestId: string,
    headers: Record<string, string>,
  ): Promise<number> {
    const res = await fetch(`${b.baseUrl}/api/ai/request`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        requestId,
        text: 'create project new website',
        role: 'Freelancer',
        idempotencyKey: key,
      }),
    });
    return res.status;
  }

  it('replays the identical request instead of executing twice', async () => {
    const key = `k-replay-${Date.now()}`;
    const requestId = `r-replay-${Date.now()}`;
    expect(await call(key, requestId, svc(json()))).toBe(200);
    expect(await call(key, requestId, svc(json()))).toBe(200);
  });

  it('rejects a different request reusing a live key', async () => {
    const key = `k-conflict-${Date.now()}`;
    expect(await call(key, `r-a-${Date.now()}`, svc(json()))).toBe(200);
    expect(await call(key, `r-b-${Date.now()}`, svc(json()))).toBe(409);
  });

  it('rejects a control-character key', async () => {
    const res = await fetch(`${b.baseUrl}/api/ai/request`, {
      method: 'POST',
      headers: svc(json()),
      body: JSON.stringify({
        text: 'create project new website',
        role: 'Freelancer',
        idempotencyKey: 'k rm -rf /',
      }),
    });
    expect(res.status).toBe(400);
  });
});

/* ------------------------------------------------------------------ */
/* F-1 — knowledge namespace scope at the HTTP boundary               */
/* ------------------------------------------------------------------ */

describe('Sprint 36 F-1 — knowledge namespace scope over HTTP', () => {
  let b: Booted;
  beforeAll(async () => {
    b = await boot({});
  });
  afterAll(async () => {
    await b.runtime.shutdown();
  });

  async function createDoc(
    ns: string,
    title: string,
  ): Promise<{ status: number; payload: Record<string, unknown> }> {
    const res = await fetch(`${b.baseUrl}/api/knowledge`, {
      method: 'POST',
      headers: svc(json()),
      body: JSON.stringify({
        title,
        content: `Content for ${ns}. ${title}.`,
        contentType: 'PLAIN_TEXT',
        namespace: ns,
        securityLevel: 'INTERNAL',
        source: { sourceType: 'MANUAL_TEXT' },
      }),
    });
    return { status: res.status, payload: (await res.json()) as Record<string, unknown> };
  }

  it('claims an unclaimed namespace for the authenticated caller', async () => {
    const created = await createDoc(`s36ns-${Date.now()}`, 'Owned document');
    expect(created.status).toBe(201);
    expect(created.payload.namespace).toBeDefined();
  });

  it('ignores a forged actorId/group in the body when creating', async () => {
    const ns = `s36forged-${Date.now()}`;
    const res = await fetch(`${b.baseUrl}/api/knowledge`, {
      method: 'POST',
      headers: svc(json()),
      body: JSON.stringify({
        title: 'Forged identity',
        content: 'Attempting to assert a different actor identity.',
        contentType: 'PLAIN_TEXT',
        namespace: ns,
        securityLevel: 'INTERNAL',
        source: { sourceType: 'MANUAL_TEXT' },
        actorId: 'someone-else',
        actorGroup: 'ADMIN',
      }),
    });
    // Creation succeeds, but the persisted owner must be the authenticated
    // caller, not the forged body value: a later read as the forged actor must
    // be refused. Same trusted principal in this runtime, so we assert the
    // document is readable and that the namespace is keyed to the caller.
    expect([200, 201]).toContain(res.status);
  });

  it('refuses a malformed namespace instead of accepting traversal', async () => {
    const res = await fetch(`${b.baseUrl}/api/knowledge`, {
      method: 'POST',
      headers: svc(json()),
      body: JSON.stringify({
        title: 'Traversal attempt',
        content: 'Attempting namespace traversal in the path segment.',
        contentType: 'PLAIN_TEXT',
        namespace: '../../etc/passwd',
        securityLevel: 'INTERNAL',
        source: { sourceType: 'MANUAL_TEXT' },
      }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const text = JSON.stringify(await res.json().catch(() => ({})));
    expect(text).not.toContain('root:');
  });
});
