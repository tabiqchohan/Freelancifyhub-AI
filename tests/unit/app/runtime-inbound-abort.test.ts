/**
 * Prompts15 Phase 6 — the inbound HTTP boundary (ABORT-7d/e).
 *
 * A caller that hangs up must be observed at the socket layer and must carry
 * that cancellation into the AIOS request. Previously the runtime listened only
 * for `finish` for logging: a disconnect produced no observable effect anywhere
 * in the system, so the LLM work kept running and kept being billed.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';

import { createProductionComposition } from '../../../src/app/composition-root.js';
import { createProductionRuntime } from '../../../src/app/runtime.js';
import { parseCompiledEnv } from '../../../src/app/env.js';
import type { ProductionComposition } from '../../../src/app/composition-root.js';
import type { ProductionRuntime } from '../../../src/app/runtime.js';
import { AiosService } from '../../../src/ai-operating-system/service.js';
import {
  createExecutionContext,
  AIOS_PLAN_STEPS,
} from '../../../src/ai-operating-system/execution-context.js';

interface LogRecord {
  readonly msg?: string;
  readonly reason?: string;
  readonly requestId?: string;
}

/** A pino-compatible destination that keeps every log line's JSON payload. */
async function capturingLogger(records: LogRecord[]): Promise<unknown> {
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      for (const line of chunk.toString('utf8').split('\n')) {
        const trimmed = line.trim();
        if (trimmed.length > 0) {
          try {
            records.push(JSON.parse(trimmed) as LogRecord);
          } catch {
            // Ignore non-JSON output; the runtime logs JSON in production mode.
          }
        }
      }
      callback();
    },
  });
  const pino = (await import('pino')).default;
  return pino({ level: 'info' }, sink);
}

describe('Prompts15 Phase 6 — ABORT-7d: HTTP disconnect is observed at the boundary', () => {
  let composition: ProductionComposition;
  let runtime: ProductionRuntime;
  let baseUrl: string;
  const records: LogRecord[] = [];

  async function start(): Promise<void> {
    const env = parseCompiledEnv({});
    env.memory.MEMORY_STORAGE_BACKEND = 'in-memory';
    composition = await createProductionComposition({ env });
    runtime = createProductionRuntime({
      composition,
      logger: (await capturingLogger(records)) as never,
      allowUnauthenticated: true,
    });
    const server = await runtime.start(0, '127.0.0.1');
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  }

  afterAll(async () => {
    if (runtime !== undefined) {
      await runtime.shutdown();
    }
    if (composition !== undefined) {
      await composition.storage.close();
    }
  }, 20_000);

  it('records an aborted request when the client destroys the socket mid-body', async () => {
    await start();

    const received = new Promise<string>((resolve) => {
      const socket = connect({ host: '127.0.0.1', port: Number(new URL(baseUrl).port) }, () => {
        // Declare a large body, send only a fragment, then hang up — the exact
        // shape of a client that abandons a request.
        socket.write(
          'POST /api/ai/request HTTP/1.1\r\n' +
            'Host: 127.0.0.1\r\n' +
            'Content-Type: application/json\r\n' +
            'Content-Length: 4096\r\n' +
            '\r\n' +
            '{"text":"create project',
        );
        setTimeout(() => socket.destroy(), 50);
      });
      socket.on('close', () => resolve('closed'));
      socket.on('error', () => resolve('error'));
    });

    await received;
    // Give the server a moment to emit the disconnect.
    await new Promise((resolve) => setTimeout(resolve, 250));

    const abortLog = records.find((record) => record.msg === 'http request aborted');
    expect(abortLog).toBeDefined();
    expect(abortLog?.reason).toBe('request_aborted');
    expect(abortLog?.requestId).toBeDefined();
  }, 30_000);

  it('leaves no aborted-request log when the request completes normally', async () => {
    records.length = 0;

    const res = await fetch(`${baseUrl}/livez`);
    expect(res.status).toBe(200);
    await res.text();
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(records.find((record) => record.msg === 'http request aborted')).toBeUndefined();
  }, 30_000);
});

const ctxFor = (requestId: string): never =>
  ({
    requestId,
    traceId: `trace-${requestId}`,
    input: { text: 'help' },
    actor: { actorId: 'u-1', role: 'Freelancer', namespaces: [] },
    intent: { primary: {} },
    options: {},
    stage: 'execute',
  }) as never;

describe('Prompts15 Phase 6 — ABORT-7e: the disconnect reaches the orchestrator tail', () => {
  /**
   * Builds a service whose orchestrator tail records the signal it was given and
   * can be held open, so a cancel can land while the run is in flight.
   */
  function serviceWithHoldingOrchestrator(): {
    readonly service: AiosService;
    readonly captured: { signal?: AbortSignal }[];
    readonly release: () => void;
    readonly started: () => Promise<void>;
  } {
    const captured: { signal?: AbortSignal }[] = [];
    let releaseRun = (): void => undefined;
    const holding = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    let started = (): void => undefined;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });

    const service = new AiosService({
      orchestrator: {
        execute: async (input: { signal?: AbortSignal }) => {
          captured.push({ signal: input.signal });
          started();
          await holding;
          return { status: 'SUCCESS', response: 'ok' };
        },
        cancel: async () => undefined,
      },
    } as never);

    return { service, captured, release: releaseRun, started: () => startedPromise };
  }

  function execWith(inbound: AbortSignal, requestId = 'req-disconnect') {
    return createExecutionContext({
      requestId,
      traceId: `trace-${requestId}`,
      target: { kind: 'orchestrator' } as never,
      intentId: 'help.general',
      timeoutMs: 30_000,
      plan: { target: 'orchestrator', agents: [], steps: [...AIOS_PLAN_STEPS] },
      metadata: {},
      signal: inbound,
    });
  }

  it('passes the composed execution signal to the orchestrator', async () => {
    const inbound = new AbortController();
    const harness = serviceWithHoldingOrchestrator();

    const run = harness.service.dispatch(
      ctxFor('req-disconnect'),
      execWith(inbound.signal) as never,
    );
    await harness.started();

    expect(harness.captured).toHaveLength(1);
    expect(harness.captured[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(harness.captured[0]?.signal?.aborted).toBe(false);

    harness.release();
    await run;
  });

  it('aborts the orchestrator signal when the caller disconnects', async () => {
    const inbound = new AbortController();
    const harness = serviceWithHoldingOrchestrator();

    const run = harness.service.dispatch(ctxFor('req-disc'), execWith(inbound.signal) as never);
    await harness.started();

    // Simulate the socket dropping while the orchestrator is still running.
    inbound.abort();

    expect(harness.captured[0]?.signal?.aborted).toBe(true);

    harness.release();
    await run;
  });

  it('still honours an explicit AIOS cancel on the same signal', async () => {
    const inbound = new AbortController();
    const harness = serviceWithHoldingOrchestrator();
    const requestId = 'req-cancel';

    const run = harness.service.dispatch(
      ctxFor(requestId),
      execWith(inbound.signal, requestId) as never,
    );
    await harness.started();

    // What `POST /api/ai/cancel` ends up doing while the run is in flight.
    harness.service.cancel(requestId);

    expect(harness.captured[0]?.signal?.aborted).toBe(true);

    harness.release();
    await run;
  });

  it('starts already cancelled when the caller disconnected before dispatch', async () => {
    const harness = serviceWithHoldingOrchestrator();
    const requestId = 'req-early';

    const run = harness.service.dispatch(
      ctxFor(requestId),
      execWith(AbortSignal.abort(), requestId) as never,
    );
    await harness.started();

    expect(harness.captured[0]?.signal?.aborted).toBe(true);

    harness.release();
    await run;
  });
});
