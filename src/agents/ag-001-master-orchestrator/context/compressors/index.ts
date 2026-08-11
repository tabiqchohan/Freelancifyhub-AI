import type { ContextItem } from '../types/index.js';
import type { ContextCompressor } from '../interfaces/compressor.js';
import { DeterministicCompressor, NullCompressor } from '../interfaces/compressor.js';

/**
 * Compression pipeline (prompt §11). Applies the configured compressor to each
 * item's content before budgeting. Deterministic and free of any AI/LLM.
 */
export class ContextCompressorPipeline {
  private readonly compressor: ContextCompressor;
  private readonly enabled: boolean;

  constructor(enabled: boolean, compressor: ContextCompressor = new DeterministicCompressor()) {
    this.enabled = enabled;
    this.compressor = enabled ? compressor : new NullCompressor();
  }

  compress(item: ContextItem): ContextItem {
    if (!this.enabled) {
      return item;
    }

    return { ...item, content: this.compressor.compress(item.content) };
  }
}

export type { ContextCompressor };
