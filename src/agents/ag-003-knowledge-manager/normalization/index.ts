import { KnowledgeValidationError } from '../errors/index.js';
import { computeContentHash } from '../utils/checksum.js';
import type {
  KnowledgeDocument,
  KnowledgeMetadata,
  KnowledgeSourceMetadata,
  KnowledgeNamespace,
} from '../types/index.js';
import type { KnowledgeContentType, KnowledgeSecurityLevel } from '../enums/index.js';

/**
 * Deterministic normalization for knowledge content and metadata.
 * Same input always produces the same normalized output.
 */

/** Normalizes whitespace sequences to a single space, trims the result. */
export function normalizeWhitespace(input: string): string {
  return input
    .replace(/[ \t]+/g, ' ')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();
}

/** Normalizes newlines to Unix-style (LF). */
export function normalizeNewlines(input: string): string {
  return input.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/** Normalizes title: trims, collapses whitespace. */
export function normalizeTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length === 0) {
    throw new KnowledgeValidationError('Title cannot be empty', {
      code: 'EMPTY_TITLE',
    });
  }
  return normalizeWhitespace(trimmed);
}

/** Normalizes content: newlines to LF, trims trailing whitespace per line. */
export function normalizeContent(content: string): string {
  const normalized = normalizeNewlines(content);
  const lines = normalized.split('\n').map((line) => line.trimEnd());
  return lines.join('\n').trim();
}

/** Validates that content is not empty or whitespace-only. */
export function validateContentNotEmpty(content: string): void {
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    throw new KnowledgeValidationError('Content cannot be empty or whitespace-only', {
      code: 'EMPTY_CONTENT',
    });
  }
}

/** Normalizes a namespace: non-empty, trimmed, lowercase. */
export function normalizeNamespace(namespace: string): KnowledgeNamespace {
  const trimmed = namespace.trim();
  if (trimmed.length === 0) {
    throw new KnowledgeValidationError('Namespace cannot be empty', {
      code: 'EMPTY_NAMESPACE',
    });
  }
  return trimmed.toLowerCase();
}

/** Normalizes metadata: removes empty string values, trims string values. */
export function normalizeMetadata(metadata: KnowledgeMetadata): KnowledgeMetadata {
  const normalized: Record<string, KnowledgeDocument['metadata'][string]> = {};
  for (const [key, value] of Object.entries(metadata)) {
    const trimmedKey = key.trim();
    if (trimmedKey.length === 0) {
      continue;
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        normalized[trimmedKey] = trimmed;
      }
    } else {
      normalized[trimmedKey] = value;
    }
  }
  return Object.freeze(normalized) as KnowledgeMetadata;
}

/** Normalizes source metadata. */
export function normalizeSource(source: KnowledgeSourceMetadata): KnowledgeSourceMetadata {
  return {
    sourceType: source.sourceType,
    reference: source.reference?.trim() || undefined,
    author: source.author?.trim() || undefined,
    url: source.url?.trim() || undefined,
    version: source.version?.trim() || undefined,
  };
}

/** Options for a full normalization of a knowledge input. */
export interface NormalizeKnowledgeInput {
  readonly title: string;
  readonly content: string;
  readonly namespace: KnowledgeNamespace;
  readonly contentType: KnowledgeContentType;
  readonly securityLevel: KnowledgeSecurityLevel;
  readonly source: KnowledgeSourceMetadata;
  readonly metadata?: KnowledgeMetadata;
}

/** The result of normalizing a knowledge input. */
export interface NormalizedKnowledgeInput {
  readonly title: string;
  readonly content: string;
  readonly namespace: KnowledgeNamespace;
  readonly contentType: KnowledgeContentType;
  readonly securityLevel: KnowledgeSecurityLevel;
  readonly source: KnowledgeSourceMetadata;
  readonly metadata: KnowledgeMetadata;
  readonly contentHash: string;
}

/**
 * Full deterministic normalization of knowledge input. Same input always
 * produces the same output. Throws on validation failure.
 */
export function normalizeKnowledgeInput(input: NormalizeKnowledgeInput): NormalizedKnowledgeInput {
  const title = normalizeTitle(input.title);
  const content = normalizeContent(input.content);
  validateContentNotEmpty(content);
  const namespace = normalizeNamespace(input.namespace);
  const metadata = input.metadata !== undefined ? normalizeMetadata(input.metadata) : {};
  const source = normalizeSource(input.source);
  const contentHash = computeContentHash(content);

  return {
    title,
    content,
    namespace,
    contentType: input.contentType,
    securityLevel: input.securityLevel,
    source,
    metadata,
    contentHash,
  };
}
