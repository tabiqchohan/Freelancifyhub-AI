/**
 * Sprint 25 — Admin AI Team v1. Security & output redaction utilities.
 *
 * Everything reaching the admin boundary — analytics/fraud/health signals,
 * AI-operation proposals, executive facts, knowledge documents, tool results
 * — is untrusted DATA, never instructions (Sprint 25 §6). The v1 admin agents
 * are deterministic, so they never build prompts; assistant output is advisory
 * only and never executes platform mutations. These helpers guarantee that any
 * value crossing the boundary is bounded, boundary markers are neutralized,
 * credential-looking content is redacted, and nested structures are redacted
 * before they can surface in an authorization audit.
 */

import { PROMPT_BOUNDARY, ESCAPED_BOUNDARY, truncateUtf8 } from '../../llm/security/index.js';
import {
  isLikelySecret,
  isSecretKeyName,
  redactSecrets,
} from '../../agents/ag-002-memory-manager/utils/sanitize.js';
import { AdminAIError, ADMIN_AI_ERROR_CODES } from './errors.js';

/** Upper bound on any single string passed to the admin boundary. */
export const ADMIN_SECURITY_MAX_VALUE_BYTES = 65_536;

/** Is a value likely to be a platform secret key name? Diagnostic only. */
export function looksLikeSecretKeyName(key: string): boolean {
  return isSecretKeyName(key);
}

/**
 * Sanitizes an admin-facing text: collapses whitespace, neutralizes the
 * untrusted-context boundary token, redacts secrets, then truncates to an
 * explicit byte budget. Never throws for valid strings.
 */
export function sanitizeAdminText(
  value: string,
  maxBytes = ADMIN_SECURITY_MAX_VALUE_BYTES,
): string {
  const collapsed = String(value).replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) {
    return '';
  }
  const neutralized = neutralizeBoundary(tokenizeAdminRedacted(collapsed));
  return truncateUtf8(neutralized, Math.max(1, maxBytes)).text;
}

/**
 * Neutralizes the shared untrusted-context boundary token so injected
 * delimiters are read as data, never as structure.
 */
export function neutralizeBoundary(value: string): string {
  return value.split(PROMPT_BOUNDARY).join(ESCAPED_BOUNDARY);
}

/**
 * Recursively redacts secret-shaped values (env vars, passwords, tokens,
 * connection strings, secret key names) in any JSON-safe value. Non-mutating.
 */
export function redactAdminValue(value: unknown): unknown {
  return redactSecrets(value);
}

/** Tokenizes a newline-delimited secret string (e.g. injected keys). */
function tokenizeAdminRedacted(value: string): string {
  const normalized = value.trim();
  if (looksLikePlatformSecret(normalized)) {
    return '[redacted-secret]';
  }
  return value;
}

const PLATFORM_SECRET_LINE_RE =
  /^(api[_-]?key|password|token|secret|authorization|credential|client_secret|private[_-]?key|database_url|connection_string)(\s*[=:]\s*\S+|:\s*\S+)$/i;

function looksLikePlatformSecret(value: string): boolean {
  const singleLine = value.split(/\s+/).join(' ');
  if (singleLine.length < 8 || singleLine.length > 512) {
    return false;
  }
  if (PLATFORM_SECRET_LINE_RE.test(singleLine)) {
    return true;
  }
  return isLikelySecret(singleLine);
}

/**
 * Cheap, deterministic indicator used ONLY for diagnostics and tests — never
 * the primary guard. Primary defense is treating all admin content as data in
 * the deterministic engine and modeling privileged writes as approval-gated
 * recommendations that are never executed from user text.
 */
export function hasInjectionIndicators(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  const lower = value.toLowerCase();
  const markers = [
    'ignore your system',
    'ignore all previous',
    'system prompt',
    'reveal your',
    'expose all admin',
    'expose platform',
    'admin instructions',
    'you are now',
    'secret key',
    'api key',
    '<untrusted_context>',
  ];
  return markers.some((marker) => lower.includes(marker));
}

/** True when any value in a structure contains injection indicators. */
export function containsInjectionIndicators(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsInjectionIndicators);
  }
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(containsInjectionIndicators);
  }
  return typeof value === 'string' && hasInjectionIndicators(value);
}

/** Guards a serializable input payload; rejects obvious injection shapes. */
export function assertInputPayloadSafe(input: unknown, allowInjectionShaped = false): void {
  if (!allowInjectionShaped && containsInjectionIndicators(input)) {
    throw new AdminAIError(
      ADMIN_AI_ERROR_CODES.PROMPT_INJECTION,
      'Request rejected: untrusted content contained injection indicators',
    );
  }
}

/** Bounded, redacted copy of a value for safe inclusion in a response. */
export function safeAdminValue(value: unknown, maxBytes = ADMIN_SECURITY_MAX_VALUE_BYTES): unknown {
  const redacted = redactSecrets(value);
  return sanitizeAdminRecursively(redacted, maxBytes);
}

function sanitizeAdminRecursively(value: unknown, maxBytes: number): unknown {
  if (typeof value === 'string') {
    return sanitizeAdminText(value, maxBytes);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeAdminRecursively(item, maxBytes));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[sanitizeAdminText(key, 512)] = sanitizeAdminRecursively(child, maxBytes);
    }
    return out;
  }
  return value;
}
