import type { MemoryRecord } from '../types/index.js';

/**
 * Fields that are safe to emit through logs. Memory content and metadata are
 * deliberately excluded (spec §13, §23, prompt §23) so sensitive data never
 * reaches the log sink.
 */
export interface SafeMemoryLogFields {
  readonly id: string;
  readonly namespace: string;
  readonly key: string;
  readonly type: string;
  readonly version: number;
  readonly lifecycle: string;
  readonly securityLevel: string;
  readonly priority: string;
  readonly owner: { readonly kind: string; readonly id: string };
  readonly traceId: string;
}

/** Projects a record to its log-safe fields (no content/metadata). */
export function sanitizeMemoryRecordForLogs(record: MemoryRecord): SafeMemoryLogFields {
  return {
    id: record.id,
    namespace: record.namespace,
    key: record.key,
    type: record.type,
    version: record.version,
    lifecycle: record.lifecycle,
    securityLevel: record.securityLevel,
    priority: record.priority,
    owner: { kind: record.owner.kind, id: record.owner.id },
    traceId: record.traceId,
  };
}

/**
 * Heuristic for security regression tests: flags strings that look like a
 * secret or credential (prompt §23). The memory system never stores or logs
 * secrets, but tests use this to prove redaction of content/metadata.
 */
export function isLikelySecret(value: string): boolean {
  return /(password|passwd|secret|token|api[_-]?key|apikey|authorization|private[_-]?key|credential|cookie|bearer|client[_-]?secret|pwd|passphrase|access[_-]?token|refresh[_-]?token|user[_-]?password|session[_-]?token)/i.test(
    value,
  );
}

/**
 * Matches object keys that look like secret/credential carriers. Case-
 * insensitive because secret-named keys appear in mixed case ("apiKey",
 * "API_KEY", "Api-Key").
 */
const SECRET_KEY_PATTERN =
  /password|passwd|secret|token|api[_-]?key|apikey|authorization|private[_-]?key|credential|cookie|bearer|client[_-]?secret|pwd|passphrase|access[_-]?token|refresh[_-]?token|user[_-]?password|session[_-]?token/i;

/** Returns true when a metadata/audit key should be treated as a secret. */
export function isSecretKeyName(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

const REDACTED = '[REDACTED]';

/**
 * Recursively redacts secret-looking keys/values from arbitrary JSON payloads
 * (Sprint 7 — audit redaction). Guarantees:
 *
 * - case-insensitive secret-key detection
 * - recursive over nested objects and arrays
 * - non-mutating (returns a fresh copy; the input is never touched)
 * - deterministic (same input always yields the same output)
 * - value-level redaction of anything matching {@link isLikelySecret}
 */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (isSecretKeyName(key)) {
        out[key] = REDACTED;
      } else {
        out[key] = redactSecrets(child);
      }
    }
    return out;
  }
  if (typeof value === 'string' && isLikelySecret(value)) {
    return REDACTED;
  }
  return value;
}

/** True when a value body itself (not its key) is a secret. */
export function isSecretValue(value: unknown): boolean {
  return typeof value === 'string' && isLikelySecret(value);
}
