import { KnowledgeValidationError } from '../errors/index.js';
import type { KnowledgeSizeLimits } from '../types/index.js';
import type { KnowledgeConfig } from '../config/schema.js';

/** Validates that a string is non-empty. */
export function assertNonEmpty(value: string, fieldName: string): void {
  if (value.trim().length === 0) {
    throw new KnowledgeValidationError(`${fieldName} cannot be empty`, {
      code: `EMPTY_${fieldName.toUpperCase()}`,
    });
  }
}

/**
 * Sprint 35 (Phase 14) — bounded, tame-identifier shape for the security-critical
 * identifiers that drive authorization (namespace, actor id, document id).
 *
 * Namespace and actor identifiers are authorization keys: they must never carry
 * whitespace, separators, control characters, or unbounded length that could be
 * used to collide, split, or smuggle a different key. Rejecting malformed values
 * up front keeps the persisted namespace records unambiguous.
 */
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** True when `value` is a well-formed namespace/actor/document identifier. */
export function isValidKnowledgeIdentifier(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER_PATTERN.test(value);
}

/**
 * Sprint 35 (Phase 14) — throws a validation error for a malformed identifier.
 * Rejects oversized, empty, non-string, and separator-bearing values.
 */
export function assertKnowledgeIdentifier(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new KnowledgeValidationError(`${fieldName} must be a string`, {
      code: 'INVALID_IDENTIFIER',
      details: { field: fieldName },
    });
  }
  if (!IDENTIFIER_PATTERN.test(value)) {
    throw new KnowledgeValidationError(`${fieldName} is not a valid identifier`, {
      code: 'INVALID_IDENTIFIER',
      details: { field: fieldName, maxLength: 128 },
    });
  }
  return value;
}

/** Validates content size against limits. */
export function assertContentWithinLimits(content: string, limits: KnowledgeSizeLimits): void {
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > limits.maxContentBytes) {
    throw new KnowledgeValidationError(
      `Content exceeds max size: ${bytes} > ${limits.maxContentBytes}`,
      { code: 'CONTENT_TOO_LARGE', details: { bytes, maxBytes: limits.maxContentBytes } },
    );
  }
}

/** Validates metadata key count against limits. */
export function assertMetadataWithinLimits(
  metadata: Record<string, unknown>,
  limits: KnowledgeSizeLimits,
): void {
  if (Object.keys(metadata).length > limits.maxMetadataKeys) {
    throw new KnowledgeValidationError(
      `Metadata exceeds max keys: ${Object.keys(metadata).length} > ${limits.maxMetadataKeys}`,
      { code: 'METADATA_TOO_LARGE' },
    );
  }
}

/** Derives size limits from config. */
export function sizeLimitsFromConfig(config: KnowledgeConfig): KnowledgeSizeLimits {
  return {
    maxContentBytes: config.KNOWLEDGE_MAX_CONTENT_BYTES,
    maxMetadataKeys: config.KNOWLEDGE_MAX_METADATA_KEYS,
    maxTitleLength: config.KNOWLEDGE_MAX_TITLE_LENGTH,
  };
}
