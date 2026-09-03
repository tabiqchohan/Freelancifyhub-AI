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
