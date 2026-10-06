import { describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Socket } from 'node:net';

import { createProductionComposition } from '../../../src/app/composition-root.js';
import { createProductionRuntime, SHUTDOWN_DRAIN_TIMEOUT_MS } from '../../../src/app/runtime.js';
import { parseCompiledEnv } from '../../../src/app/env.js';

/**
 * Prompts15 Phase 9 — Render / container shutdown readiness.
 *
 * Render sends SIGTERM and then force-kills the instance when its grace window
 * expires. `server.close()` alone leaves idle keep-alive sockets waiting, which
 * can hold the process past that window and produce an unclean shutdown. These
 * tests pin the drain contract:
 *
 *   - shutdown completes even while a keep-alive socket is open,
 *   - new connections are refused once shutdown begins,
 *   - the drain window is bounded, not unbounded.
 *
 * Memory backend is `in-memory` so the suite needs no database.
 */

async function startRuntime() {
  const env = parseCompiledEnv({ AIOS_SERVICE_TOKEN: 'throwaway-service-token' });
  env.memory.MEMORY_STORAGE_BACKEND = 'in-memory';
  const composition = await createProductionComposition({ env });
  const runtime = createProductionRuntime({
    composition,
    logger: (await import('pino')).default({ level: 'silent' }),
  });
  const server = await runtime.start(0, '127.0.0.1');
  const { port } = server.address() as AddressInfo;
  return { runtime, server, port, baseUrl: `http://127.0.0.1:${port}` };
}

describe('graceful shutdown (Prompts15 Phase 9)', () => {
  it('exposes a bounded drain window', () => {
    expect(SHUTDOWN_DRAIN_TIMEOUT_MS).toBeGreaterThan(0);
    // Must stay well inside a typical orchestrator grace period.
    expect(SHUTDOWN_DRAIN_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });

  it('completes promptly while an idle keep-alive socket is held open', async () => {
    const { runtime, port } = await startRuntime();

    // A keep-alive connection that completed a request but is still open, with
    // the underlying TCP socket pinned by an undici pool. `server.close()`
    // alone waits for this socket and would stall the drain; `closeIdleConnections()`
    // is what releases it.
    const { Agent, request } = await import('node:http');
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    await new Promise<void>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/healthz', agent }, (res) => {
        res.resume();
        res.on('end', () => resolve());
      });
      req.on('error', reject);
      req.end();
    });
    // Keep the socket referenced so the server still considers it live.
    const sockets = Object.values(agent.freeSockets).flat();
    expect(sockets.length + Object.values(agent.sockets).flat().length).toBeGreaterThan(0);

    const startedAt = Date.now();
    await runtime.shutdown({ drainTimeoutMs: 2_000 });
    const elapsed = Date.now() - startedAt;

    // The whole point: an idle keep-alive socket must not hold shutdown open.
    expect(elapsed).toBeLessThan(2_000);
    agent.destroy();
  }, 30_000);

  it('forces remaining sockets closed when the drain window expires', async () => {
    const { runtime, port } = await startRuntime();

    // A raw TCP connection that never sends a request: it is neither
    // `closeIdleConnections()`-eligible nor will it finish on its own. The
    // bounded drain must give up on it rather than hanging forever.
    const { connect } = await import('node:net');
    const raw = await new Promise<Socket>((resolve, reject) => {
      const sock = connect({ host: '127.0.0.1', port }, () => resolve(sock));
      sock.on('error', reject);
    });

    const startedAt = Date.now();
    await runtime.shutdown({ drainTimeoutMs: 500 });
    const elapsed = Date.now() - startedAt;

    // Bounded: must return near the requested window, not hang, and not
    // return instantly (which would mean active work was not given a chance).
    expect(elapsed).toBeGreaterThanOrEqual(400);
    expect(elapsed).toBeLessThan(5_000);
    raw.destroy();
  }, 30_000);

  it('stops accepting new connections once shutdown has begun', async () => {
    const { runtime, baseUrl } = await startRuntime();
    await runtime.shutdown({ drainTimeoutMs: 1_000 });

    await expect(fetch(`${baseUrl}/healthz`)).rejects.toThrow();
  }, 30_000);

  it('is idempotent: a second shutdown is a no-op', async () => {
    const { runtime } = await startRuntime();
    await runtime.shutdown({ drainTimeoutMs: 1_000 });
    await expect(runtime.shutdown({ drainTimeoutMs: 1_000 })).resolves.toBeUndefined();
  }, 30_000);

  it('keeps liveness open while serving, then closes cleanly', async () => {
    const { runtime, baseUrl } = await startRuntime();
    const live = await fetch(`${baseUrl}/healthz`);
    expect(live.status).toBe(200);
    await runtime.shutdown({ drainTimeoutMs: 1_000 });
  }, 30_000);
});
