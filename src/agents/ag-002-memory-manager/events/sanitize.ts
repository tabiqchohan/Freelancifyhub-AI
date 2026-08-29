import type { MemoryJsonValue } from '../types/index.js';
import { isSecretKeyName, isSecretValue, redactSecrets } from '../utils/sanitize.js';
import type { MemoryEvent } from './index.js';

/**
 * Sprint 7 — Event sanitization (spec §5). SECURITY-CRITICAL.
 *
 * Event payloads must never leak secrets (apiKey, password, token, secret,
 * credential, pwd, passphrase, authorization headers, ...). Sanitization is:
 *
 * - case-insensitive (secret-named keys in any case are caught)
 * - nested (recurses objects and arrays)
 * - non-mutating (returns a fresh copy; the input is never touched)
 * - deterministic (same input always yields the same output)
 *
 * This reuses the canonical util sanitizer (`redactSecrets`) rather than
 * introducing a second, incompatible sanitizer.
 */

/**
 * Returns a sanitized, non-mutating copy of an event's metadata. Content is
 * never carried by events, so only the free-form metadata map is scrubbed.
 */
export function sanitizeEventMetadata(
  metadata: Readonly<Record<string, MemoryJsonValue>> | undefined,
): Readonly<Record<string, MemoryJsonValue>> | undefined {
  if (metadata === undefined) {
    return undefined;
  }
  return (redactSecrets(metadata) as Record<string, MemoryJsonValue>) ?? {};
}

/** True when any secret-looking key/value appears in the metadata. */
export function metadataContainsSecret(
  metadata: Readonly<Record<string, MemoryJsonValue>> | undefined,
): boolean {
  if (metadata === undefined) {
    return false;
  }
  return containsSecretValue(metadata);
}

function containsSecretValue(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => containsSecretValue(item));
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).some(
      ([key, child]) => isSecretKeyName(key) || containsSecretValue(child),
    );
  }
  return isSecretValue(value);
}

/**
 * Produces a sanitized (deep, non-mutating) copy of a transport event. Only the
 * metadata map can carry free-form values in the current contract, so it is the
 * primary redaction surface; string detail fields are passed through but never
 * contain content. The original event is never mutated.
 */
export function sanitizeEvent(event: MemoryEvent): MemoryEvent {
  const metadata = sanitizeEventMetadata(event.metadata);
  return {
    ...event,
    metadata,
  };
}
