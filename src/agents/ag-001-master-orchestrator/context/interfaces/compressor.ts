import type { ContextItem } from '../types/index.js';

/**
 * Deterministic context compaction (prompt §11). No LLM, no summarization —
 * only safe, reversible whitespace normalization. A future AI compressor can
 * implement this same interface.
 */
export interface ContextCompressor {
  /** Returns a compacted (or unchanged) copy of the item content. */
  compress(content: string): string;
}

/**
 * Basic deterministic compaction: collapses runs of whitespace. Guaranteed to
 * reduce or preserve token count, never alter meaning.
 */
export class DeterministicCompressor implements ContextCompressor {
  compress(content: string): string {
    return content.replace(/\s+/g, ' ').trim();
  }
}

/**
 * No-op compressor, used when compression is disabled. Keeps the pipeline
 * branch-free and deterministic.
 */
export class NullCompressor implements ContextCompressor {
  compress(content: string): string {
    return content;
  }
}

export type { ContextItem };
