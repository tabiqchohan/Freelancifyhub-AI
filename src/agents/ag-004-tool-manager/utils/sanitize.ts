import {
  isLikelySecret,
  isSecretKeyName,
  redactSecrets,
} from '../../ag-002-memory-manager/utils/sanitize.js';
import type { ToolJsonValue, ToolResult } from '../types/index.js';

/**
 * Tool result sanitization. Prevents accidental leakage of environment
 * variables, tokens, passwords, connection strings, authorization headers,
 * and secret keys. Reuses AG-002's canonical `redactSecrets` utility rather
 * than introducing a second, incompatible sanitizer.
 */

/** Recursively sanitizes arbitrary tool output into a JSON-safe, redacted form. */
export function sanitizeToolOutput(value: unknown): ToolJsonValue {
  return redactSecrets(value) as ToolJsonValue;
}

/** True when a tool output contains a likely secret (diagnostic only). */
export function toolOutputContainsSecret(value: unknown): boolean {
  return containsSecret(value);
}

function containsSecret(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => containsSecret(item));
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).some(
      ([key, child]) => isSecretKeyName(key) || containsSecret(child),
    );
  }
  return typeof value === 'string' && isLikelySecret(value);
}

/**
 * Produces a sanitized copy of a tool result. Output is deep-redacted;
 * metadata (ids, status, durations) are preserved.
 */
export function sanitizeToolResult(result: ToolResult): ToolResult {
  return {
    ...result,
    output: result.output === undefined ? undefined : (sanitizeToolOutput(result.output) as never),
  };
}
