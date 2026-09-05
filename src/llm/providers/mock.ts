/**
 * Sprint 17 — Deterministic in-memory mock LLM provider.
 *
 * Never performs network I/O. Responses are deterministic and derived from
 * message structure (counts/lengths only). Raw content is never retained:
 * each captured request stores safe metadata only, so unit tests can assert
 * shape without risking secret leakage into the test surface.
 */

import type { LLMConfig } from '../config/schema.js';
import type { LLMProvider, LLMRequest, LLMRequestOptions, LLMResponse } from '../types/index.js';

/** Safe metadata captured per mock request (never content). */
export interface MockCapturedRequest {
  readonly id: string;
  readonly model: string;
  readonly messageCount: number;
  readonly totalContentChars: number;
  readonly requestId?: string;
  readonly timestamp: string;
}

/** Options for the mock provider. */
export interface MockLLMProviderOptions {
  readonly config: Pick<LLMConfig, 'LLM_MODEL'>;
  readonly idFactory?: () => string;
}

/** Deterministic, in-memory LLM provider used by unit tests and E2E. */
export class MockLLMProvider implements LLMProvider {
  readonly id = 'mock';
  readonly model: string;

  private readonly captured: MockCapturedRequest[] = [];
  private readonly idFactory: () => string;
  private readonly simulatedErrors: unknown[] = [];

  constructor(options: MockLLMProviderOptions) {
    this.model = options.config.LLM_MODEL;
    this.idFactory = options.idFactory ?? defaultMockIdFactory;
  }

  /** Enqueues an error thrown by the next `generate` calls (test knob). */
  enqueueSimulatedError(error: unknown): void {
    this.simulatedErrors.push(error);
  }

  /** Safe metadata of every request observed (no content, no secrets). */
  capturedRequests(): readonly MockCapturedRequest[] {
    return [...this.captured];
  }

  /** Clears captured metadata and simulated errors (test isolation). */
  reset(): void {
    this.captured.length = 0;
    this.simulatedErrors.length = 0;
  }

  async generate(request: LLMRequest, options: LLMRequestOptions = {}): Promise<LLMResponse> {
    if (this.simulatedErrors.length > 0) {
      throw this.simulatedErrors.shift();
    }

    const id = this.idFactory();
    const messageCount = request.messages.length;
    const totalContentChars = request.messages.reduce(
      (sum, message) => sum + Buffer.byteLength(message.content, 'utf8'),
      0,
    );

    this.captured.push({
      id,
      model: request.model ?? this.model,
      messageCount,
      totalContentChars,
      requestId: options.requestId,
      timestamp: new Date().toISOString(),
    });

    return {
      text: `MOCK:processed ${messageCount} message(s), ${totalContentChars} content bytes`,
      provider: this.id,
      model: request.model ?? this.model,
      requestId: id,
      attempts: 1,
      usage: {
        inputTokens: messageCount,
        outputTokens: 1,
        totalTokens: messageCount + 1,
      },
      finishReason: 'stop',
    };
  }
}

function defaultMockIdFactory(): string {
  return `mock_${Date.now()}`;
}

/** Convenience: builds a mock provider from an LLM config slice. */
export function createMockProvider(config: Pick<LLMConfig, 'LLM_MODEL'>): MockLLMProvider {
  return new MockLLMProvider({ config });
}
