/**
 * Token estimator contract for context budgeting (Sprint 4, prompt §17).
 * Provides deterministic token estimation without external dependencies.
 */
import type { MemoryRecord } from '../types/index.js';

export interface TokenEstimator {
  readonly name: string;
  estimate(record: MemoryRecord): number;
  estimateText(text: string): number;
}

/**
 * Simple deterministic token estimator based on character count.
 * Approximates 1 token ≈ 4 characters (standard GPT tokenizer approximation).
 */
export class SimpleTokenEstimator implements TokenEstimator {
  readonly name = 'simple-token-estimator';

  private readonly charsPerToken: number;

  constructor(charsPerToken = 4) {
    this.charsPerToken = charsPerToken;
  }

  estimate(record: MemoryRecord): number {
    let total = 0;

    // Content
    if (record.content) {
      total += this.estimateText(
        typeof record.content === 'string' ? record.content : JSON.stringify(record.content),
      );
    }

    // Key
    total += this.estimateText(record.key);

    // Type
    total += this.estimateText(record.type);

    // Metadata
    for (const [key, value] of Object.entries(record.metadata ?? {})) {
      total += this.estimateText(key);
      if (typeof value === 'string') {
        total += this.estimateText(value);
      }
    }

    // Namespace
    total += this.estimateText(record.namespace);

    // Owner
    if (record.owner) {
      total += this.estimateText(record.owner.kind);
      total += this.estimateText(record.owner.id);
    }

    return total;
  }

  estimateText(text: string): number {
    if (!text) return 0;
    // Simple approximation: tokens = ceil(chars / charsPerToken)
    return Math.ceil(text.length / this.charsPerToken);
  }
}
