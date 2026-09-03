import { describe, expect, it } from 'vitest';

import { KnowledgeSourceType } from '../../../../src/agents/ag-003-knowledge-manager/enums/index.js';
import { KnowledgeValidationError } from '../../../../src/agents/ag-003-knowledge-manager/errors/index.js';
import {
  normalizeKnowledgeInput,
  normalizeWhitespace,
  normalizeNewlines,
} from '../../../../src/agents/ag-003-knowledge-manager/normalization/index.js';
import { computeContentHash } from '../../../../src/agents/ag-003-knowledge-manager/utils/checksum.js';
import {
  KnowledgeContentType,
  KnowledgeSecurityLevel,
} from '../../../../src/agents/ag-003-knowledge-manager/enums/index.js';

describe('AG-003 normalization - deterministic behavior', () => {
  it('produces the same output for the same input', () => {
    const input = {
      title: 'Test Doc',
      content: 'Hello   world\n\nSecond line',
      namespace: 'ns-1',
      contentType: KnowledgeContentType.PlainText,
      securityLevel: KnowledgeSecurityLevel.Internal,
      source: { sourceType: KnowledgeSourceType.ManualText },
      metadata: { a: ' b ' },
    };
    const a = normalizeKnowledgeInput(input);
    const b = normalizeKnowledgeInput(input);
    expect(a.content).toBe(b.content);
    expect(a.contentHash).toBe(b.contentHash);
    expect(a.title).toBe(b.title);
  });

  it('normalizes duplicate whitespace', () => {
    expect(normalizeWhitespace('a   b\tc  d')).toBe('a b c d');
  });

  it('normalizes newline variants to LF', () => {
    expect(normalizeNewlines('a\r\nb\rc\n')).toBe('a\nb\nc\n');
  });

  it('trims the title', () => {
    const out = normalizeKnowledgeInput({
      title: '  My Title  ',
      content: 'body',
      namespace: 'ns-1',
      contentType: KnowledgeContentType.PlainText,
      securityLevel: KnowledgeSecurityLevel.Internal,
      source: { sourceType: KnowledgeSourceType.ManualText },
    });
    expect(out.title).toBe('My Title');
  });

  it('rejects empty content', () => {
    expect(() =>
      normalizeKnowledgeInput({
        title: 'T',
        content: '',
        namespace: 'ns-1',
        contentType: KnowledgeContentType.PlainText,
        securityLevel: KnowledgeSecurityLevel.Internal,
        source: { sourceType: KnowledgeSourceType.ManualText },
      }),
    ).toThrow(KnowledgeValidationError);
  });

  it('rejects whitespace-only content', () => {
    expect(() =>
      normalizeKnowledgeInput({
        title: 'T',
        content: '   \n\t ',
        namespace: 'ns-1',
        contentType: KnowledgeContentType.PlainText,
        securityLevel: KnowledgeSecurityLevel.Internal,
        source: { sourceType: KnowledgeSourceType.ManualText },
      }),
    ).toThrow(KnowledgeValidationError);
  });

  it('rejects empty title', () => {
    expect(() =>
      normalizeKnowledgeInput({
        title: '   ',
        content: 'body',
        namespace: 'ns-1',
        contentType: KnowledgeContentType.PlainText,
        securityLevel: KnowledgeSecurityLevel.Internal,
        source: { sourceType: KnowledgeSourceType.ManualText },
      }),
    ).toThrow(KnowledgeValidationError);
  });

  it('handles Unicode content deterministically', () => {
    const out = normalizeKnowledgeInput({
      title: 'Ünïcode',
      content: '日本語のテキスト and emoji 😀',
      namespace: 'ns-1',
      contentType: KnowledgeContentType.PlainText,
      securityLevel: KnowledgeSecurityLevel.Internal,
      source: { sourceType: KnowledgeSourceType.ManualText },
    });
    expect(out.content).toContain('日本語');
    expect(out.content).toContain('😀');
  });

  it('generates a deterministic content checksum', () => {
    const h1 = computeContentHash('same content');
    const h2 = computeContentHash('same content');
    const h3 = computeContentHash('different content');
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('handles very large content without losing determinism', () => {
    const content = 'word '.repeat(100_000);
    const out = normalizeKnowledgeInput({
      title: 'Large',
      content,
      namespace: 'ns-1',
      contentType: KnowledgeContentType.PlainText,
      securityLevel: KnowledgeSecurityLevel.Internal,
      source: { sourceType: KnowledgeSourceType.ManualText },
    });
    expect(out.content.length).toBeGreaterThan(content.length * 0.9);
  });

  it('normalizes malformed metadata safely', () => {
    const out = normalizeKnowledgeInput({
      title: 'T',
      content: 'body',
      namespace: 'ns-1',
      contentType: KnowledgeContentType.PlainText,
      securityLevel: KnowledgeSecurityLevel.Internal,
      source: { sourceType: KnowledgeSourceType.ManualText },
      metadata: { '': 'ignored', key: '  value  ', keep: 42 },
    });
    expect(out.metadata['key']).toBe('value');
    expect(out.metadata['']).toBeUndefined();
    expect(out.metadata['keep']).toBe(42);
  });

  it('duplicate normalized content yields identical checksums', () => {
    const out1 = normalizeKnowledgeInput({
      title: 'T1',
      content: 'two spaces\r\nnext',
      namespace: 'ns-1',
      contentType: KnowledgeContentType.PlainText,
      securityLevel: KnowledgeSecurityLevel.Internal,
      source: { sourceType: KnowledgeSourceType.ManualText },
    });
    const out2 = normalizeKnowledgeInput({
      title: 'T2',
      content: 'two spaces\nnext',
      namespace: 'ns-1',
      contentType: KnowledgeContentType.PlainText,
      securityLevel: KnowledgeSecurityLevel.Internal,
      source: { sourceType: KnowledgeSourceType.ManualText },
    });
    expect(out1.content).toBe(out2.content);
    expect(out1.contentHash).toBe(out2.contentHash);
  });
});
