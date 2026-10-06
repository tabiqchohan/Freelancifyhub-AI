/**
 * Prompts15 Phase 6 — inbound cancellation reaches the outbound LLM fetch.
 *
 * ABORT-1..7 cover the chain a caller disconnect has to travel:
 *
 *   HTTP socket -> inbound signal -> AIOS execution -> orchestrator engine ->
 *   agent executor -> reasoning service -> generateWithRetry -> real fetch
 *
 * The decisive test (ABORT-7) runs the actual `HttpLLMProvider` against a local
 * upstream server and asserts the upstream socket was torn down — not merely
 * that a promise rejected, which is what the pre-fix code did.
 */

import { describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { anyAbortSignal, linkAbort } from '../../../src/lib/abort.js';
import { createExecutionContext } from '../../../src/ai-operating-system/execution-context.js';
import { AIOS_PLAN_STEPS } from '../../../src/ai-operating-system/execution-context.js';
import { HttpLLMProvider } from '../../../src/llm/providers/http.js';
import { generateWithRetry } from '../../../src/llm/retry/index.js';
import { LLMCancelledError } from '../../../src/llm/errors/index.js';
import type { LLMConfig } from '../../../src/llm/config/schema.js';

/** An upstream that accepts the request and then deliberately never answers. */
function stallingUpstream(): Promise<{
  readonly baseUrl: string;
  readonly socketsClosed: () => number;
  readonly requests: () => number;
  readonly close: () => Promise<void>;
}> {
  let closed = 0;
  let requests = 0;

  const server: Server = createServer((req, res) => {
    requests += 1;
    // Consume the body so the request is fully received, then hang forever.
    req.on('data', () => undefined);
    req.on('end', () => undefined);
    res.on('close', () => {
      if (!res.writableFinished) {
        closed += 1;
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        socketsClosed: () => closed,
        requests: () => requests,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

const validPayload = JSON.stringify({
  id: 'cmpl-1',
  model: 'test-model',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
});

function providerFor(baseUrl: string): HttpLLMProvider {
  const config = {
    LLM_BASE_URL: baseUrl,
    LLM_API_KEY: 'sk-unit-test-key',
    LLM_MODEL: 'test-model',
    LLM_TIMEOUT_MS: 10_000,
    LLM_MAX_RESPONSE_BYTES: 1_048_576,
  } as unknown as LLMConfig;
  return new HttpLLMProvider({ config });
}

describe('Prompts15 Phase 6 — ABORT: inbound disconnect reaches the provider', () => {
  it('ABORT-1: composes an already-aborted signal with a live one as aborted', () => {
    const aborted = AbortSignal.abort();
    const live = new AbortController().signal;

    expect(anyAbortSignal([aborted, live])?.aborted).toBe(true);
  });

  it('ABORT-2: a composite signal aborts when any input aborts', () => {
    const a = new AbortController();
    const b = new AbortController();
    const composite = anyAbortSignal([a.signal, b.signal]);

    expect(composite?.aborted).toBe(false);
    b.abort();
    expect(composite?.aborted).toBe(true);
  });

  it('ABORT-3: linkAbort detaches idempotently and never fires after detach', () => {
    const controller = new AbortController();
    let fired = 0;
    const detach = linkAbort(controller.signal, () => {
      fired += 1;
    });

    detach();
    detach();
    controller.abort();

    expect(fired).toBe(0);
  });

  it('ABORT-4: the execution signal aborts when the caller disconnects, and `requested` follows', () => {
    const inbound = new AbortController();
    const exec = createExecutionContext({
      requestId: 'req-abort',
      traceId: 'trace-abort',
      target: { kind: 'team' } as never,
      intentId: 'intent',
      timeoutMs: 30_000,
      plan: { target: 'team', agents: [], steps: [...AIOS_PLAN_STEPS] },
      metadata: {},
      signal: inbound.signal,
    });

    expect(exec.cancellation.signal.aborted).toBe(false);
    expect(exec.cancellation.requested).toBe(false);

    inbound.abort();

    // The tail observes cancellation live — a snapshot would still read false.
    expect(exec.cancellation.signal.aborted).toBe(true);
    expect(exec.cancellation.requested).toBe(true);
  });

  it('ABORT-5: an explicit cancel still aborts the composite used by the tail', () => {
    const inbound = new AbortController();
    const exec = createExecutionContext({
      requestId: 'req-cancel',
      traceId: 'trace-cancel',
      target: { kind: 'team' } as never,
      intentId: 'intent',
      timeoutMs: 30_000,
      plan: { target: 'team', agents: [], steps: [...AIOS_PLAN_STEPS] },
      metadata: {},
      signal: inbound.signal,
    });

    // What `AiosService.cancel()` does.
    exec.controller.abort();

    expect(exec.cancellation.signal.aborted).toBe(true);
  });

  it('ABORT-6: a caller already disconnected before dispatch is observed as cancelled', () => {
    const exec = createExecutionContext({
      requestId: 'req-late',
      traceId: 'trace-late',
      target: { kind: 'team' } as never,
      intentId: 'intent',
      timeoutMs: 30_000,
      plan: { target: 'team', agents: [], steps: [...AIOS_PLAN_STEPS] },
      metadata: {},
      signal: AbortSignal.abort(),
    });

    expect(exec.cancellation.requested).toBe(true);
  });

  it('ABORT-7: a disconnect tears down the real outbound LLM socket', async () => {
    const upstream = await stallingUpstream();
    const provider = providerFor(upstream.baseUrl);
    const controller = new AbortController();

    try {
      // The provider hangs forever, so the only way out is the abort.
      const pending = provider.generate(
        { messages: [{ role: 'user', content: 'hello' }] },
        { signal: controller.signal, timeoutMs: 10_000 },
      );

      // Give the request time to reach the upstream before hanging up.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(upstream.requests()).toBe(1);

      controller.abort();

      await expect(pending).rejects.toBeInstanceOf(LLMCancelledError);

      // The socket really was released rather than left dangling.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(upstream.socketsClosed()).toBe(1);
    } finally {
      await upstream.close();
    }
  });

  it('ABORT-7b: the retry chain stops immediately and never opens a second attempt', async () => {
    const upstream = await stallingUpstream();
    const provider = providerFor(upstream.baseUrl);
    const controller = new AbortController();

    try {
      const pending = generateWithRetry(
        (budget) =>
          provider.generate(
            { messages: [{ role: 'user', content: 'hello' }] },
            { signal: controller.signal, timeoutMs: budget.timeoutMs },
          ),
        {
          retries: { maxRetries: 5, backoffBaseMs: 1, backoffMaxMs: 1 },
          timeoutMs: 10_000,
          signal: controller.signal,
        },
      );

      await new Promise((resolve) => setTimeout(resolve, 100));
      controller.abort();

      await expect(pending).rejects.toBeInstanceOf(LLMCancelledError);
      // Cancellation is not retryable, so no further attempt was attempted.
      expect(upstream.requests()).toBe(1);
    } finally {
      await upstream.close();
    }
  });

  it('ABORT-7c: a completed request leaves the response readable and the chain resolved', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(validPayload);
    });
    const baseUrl = await new Promise<string>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
      });
    });

    try {
      const provider = providerFor(baseUrl);
      const result = await provider.generate({
        messages: [{ role: 'user', content: 'hello' }],
      });
      expect(result.text).toBe('ok');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});
