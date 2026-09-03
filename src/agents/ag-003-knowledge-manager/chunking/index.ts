import { createChunkId } from '../utils/ids.js';
import { computeContentHash } from '../utils/checksum.js';
import type {
  KnowledgeChunk,
  KnowledgeChunkId,
  KnowledgeId,
  KnowledgeMetadata,
  KnowledgeVersionId,
} from '../types/index.js';

/**
 * Deterministic chunking engine. Splits content into fixed-size chunks with
 * configurable overlap. Chunk IDs are deterministic for the same input.
 */

/** Configuration for the chunking engine. */
export interface ChunkingConfig {
  /** Maximum characters per chunk. */
  readonly maxChunkSize: number;
  /** Number of characters of overlap between adjacent chunks. */
  readonly overlapSize: number;
}

/** Default chunking configuration. */
export const DEFAULT_CHUNKING_CONFIG: ChunkingConfig = {
  maxChunkSize: 1000,
  overlapSize: 100,
};

/** Validates chunking configuration. */
function validateConfig(config: ChunkingConfig): void {
  if (config.maxChunkSize <= 0) {
    throw new RangeError('maxChunkSize must be positive');
  }
  if (config.overlapSize < 0) {
    throw new RangeError('overlapSize must be non-negative');
  }
  if (config.overlapSize >= config.maxChunkSize) {
    throw new RangeError('overlapSize must be less than maxChunkSize');
  }
}

/**
 * Splits text into overlapping chunks deterministically. Empty/whitespace-only
 * input produces an empty array.
 */
export function splitIntoChunks(text: string, config: ChunkingConfig): readonly string[] {
  validateConfig(config);

  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return [];
  }

  if (trimmed.length <= config.maxChunkSize) {
    return [trimmed];
  }

  const chunks: string[] = [];
  let start = 0;

  while (start < trimmed.length) {
    const end = Math.min(start + config.maxChunkSize, trimmed.length);
    chunks.push(trimmed.slice(start, end));

    if (end >= trimmed.length) {
      break;
    }

    start += config.maxChunkSize - config.overlapSize;
    if (start >= trimmed.length) {
      break;
    }
  }

  return chunks;
}

/**
 * Deterministic chunk ID: same document + version + chunk index always
 * produces the same ID. Uses a deterministic prefix derived from the
 * content hash rather than random UUIDs for the pure chunking function.
 */
export function deterministicChunkId(
  documentId: string,
  versionNumber: number,
  chunkIndex: number,
): KnowledgeChunkId {
  const hash = computeContentHash(`${documentId}:v${versionNumber}:chunk:${chunkIndex}`);
  return `kchunk_${hash.slice(0, 12)}` as KnowledgeChunkId;
}

/** Input for chunking a versioned document. */
export interface ChunkDocumentInput {
  readonly documentId: KnowledgeId;
  readonly versionId: KnowledgeVersionId;
  readonly versionNumber: number;
  readonly content: string;
  readonly metadata: KnowledgeMetadata;
  readonly createdAt: string;
  readonly config?: Partial<ChunkingConfig>;
}

/**
 * Chunks a versioned document's content into KnowledgeChunk entities.
 * Deterministic: same input produces the same output.
 */
export function chunkDocument(input: ChunkDocumentInput): readonly KnowledgeChunk[] {
  const config: ChunkingConfig = {
    maxChunkSize: input.config?.maxChunkSize ?? DEFAULT_CHUNKING_CONFIG.maxChunkSize,
    overlapSize: input.config?.overlapSize ?? DEFAULT_CHUNKING_CONFIG.overlapSize,
  };

  const textChunks = splitIntoChunks(input.content, config);

  return textChunks.map((chunkContent, index): KnowledgeChunk => ({
    id: createChunkId(),
    documentId: input.documentId,
    versionId: input.versionId,
    versionNumber: input.versionNumber,
    chunkIndex: index,
    content: chunkContent,
    contentHash: computeContentHash(chunkContent),
    metadata: input.metadata,
    createdAt: input.createdAt,
  }));
}
