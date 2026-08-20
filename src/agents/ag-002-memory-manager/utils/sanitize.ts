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
  return /(password|passwd|secret|token|api[_-]?key|authorization|private[_-]?key|credential|cookie|bearer|client[_-]?secret)/i.test(
    value,
  );
}
