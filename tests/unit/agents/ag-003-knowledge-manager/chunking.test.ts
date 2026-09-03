import { describe, expect, it } from 'vitest';

import {
  splitIntoChunks,
  chunkDocument,
} from '../../../../src/agents/ag-003-knowledge-manager/chunking/index.js';
import { createKnowledgeVersionId } from '../../../../src/agents/ag-003-knowledge-manager/utils/ids.js';

const cfg = { maxChunkSize: 10, overlapSize: 2 };

describe('AG-003 chunking - deterministic engine', () => {
  it('is deterministic: same input -> same output', () => {
    const text = 'abcdefghijklmnopqrstuvwxyz';
    const a = splitIntoChunks(text, cfg);
    const b = splitIntoChunks(text, cfg);
    expect(a).toEqual(b);
  });

  it('handles small documents (single chunk)', () => {
    const chunks = splitIntoChunks('abc', { maxChunkSize: 10, overlapSize: 2 });
    expect(chunks).toEqual(['abc']);
  });

  it('handles exact boundary sizes', () => {
    const chunks = splitIntoChunks('abcdefghij', { maxChunkSize: 10, overlapSize: 0 });
    expect(chunks).toEqual(['abcdefghij']);
  });

  it('handles large documents with overlap', () => {
    const chunks = splitIntoChunks('abcdefghijklmnopqrstuvwxyz', {
      maxChunkSize: 10,
      overlapSize: 2,
    });
    expect(chunks.length).toBeGreaterThan(1);
    // The first chunk is the first 10 chars
    expect(chunks[0]).toBe('abcdefghij');
  });

  it('handles empty documents (no chunks)', () => {
    expect(splitIntoChunks('', cfg)).toEqual([]);
  });

  it('handles whitespace-only documents (no chunks)', () => {
    expect(splitIntoChunks('   ', cfg)).toEqual([]);
  });

  it('handles Unicode text', () => {
    const text = '日本語のテキストです、これはテストです。さらに長い内容。';
    const chunks = splitIntoChunks(text, { maxChunkSize: 5, overlapSize: 1 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toContain('日本語');
  });

  it('ensures the last partial chunk is retained', () => {
    const chunks = splitIntoChunks('abcdefghijklm', { maxChunkSize: 4, overlapSize: 0 });
    expect(chunks.at(-1)).toBe('m');
  });

  it('chunkDocument creates KnowledgeChunk entities with relationships', () => {
    const versionId = createKnowledgeVersionId();
    const versionNumber = 3;
    const chunks = chunkDocument({
      documentId: 'knowledge_doc1',
      versionId,
      versionNumber,
      content:
        'This is a longer paragraph that will be split into multiple chunks for testing determinism and correctness.',
      metadata: { key: 'value' },
      createdAt: '2026-01-01T00:00:00.000Z',
      config: { maxChunkSize: 20, overlapSize: 3 },
    });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.documentId).toBe('knowledge_doc1');
      expect(chunk.versionId).toBe(versionId);
      expect(chunk.versionNumber).toBe(3);
      expect(chunk.metadata).toEqual({ key: 'value' });
      expect(chunk.contentHash).toMatch(/^[0-9a-f]{64}$/);
    }

    // Chunk indices are stable/ordered
    const indices = chunks.map((c) => c.chunkIndex);
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
  });

  it('chunks inherit version metadata', () => {
    const chunks = chunkDocument({
      documentId: 'doc',
      versionId: 'ver',
      versionNumber: 1,
      content: 'something worth chunking into pieces for metadata inheritance checks',
      metadata: { inherited: true },
      createdAt: '2026-01-01T00:00:00.000Z',
      config: { maxChunkSize: 15, overlapSize: 2 },
    });
    for (const chunk of chunks) {
      expect(chunk.metadata).toEqual({ inherited: true });
    }
  });
});
