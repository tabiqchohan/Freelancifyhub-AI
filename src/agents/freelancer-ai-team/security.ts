/**
 * Sprint 22 — Freelancer AI Team v1. Security & output redaction utilities.
 *
 * Freelancer text, retrieved memory, knowledge documents and tool output are
 * all treated as untrusted DATA — never as instructions. The v1 freelancer
 * agents are deterministic, so they never build prompts; these helpers
 * guarantee that any value crossing the freelancer boundary is bounded,
 * boundary markers are neutralized and credential-looking content is redacted.
 */

import { PROMPT_BOUNDARY, ESCAPED_BOUNDARY, truncateUtf8 } from '../../llm/security/index.js';
import {
  isLikelySecret,
  isSecretKeyName,
  redactSecrets,
} from '../../agents/ag-002-memory-manager/utils/sanitize.js';
import { FreelancerAIError, FREELANCER_AI_ERROR_CODES } from './errors.js';

/** Upper bound on any single string passed to the freelancer boundary. */
export const FREELANCER_SECURITY_MAX_VALUE_BYTES = 65_536;

/**
 * Sanitizes a freelancer-facing text: collapses whitespace, neutralizes the
 * untrusted-context boundary token, redacts secrets, then truncates to an
 * explicit byte budget. Never throws for valid strings.
 */
export function sanitizeFreelancerText(
  value: string,
  maxBytes = FREELANCER_SECURITY_MAX_VALUE_BYTES,
): string {
  const collapsed = String(value).replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) {
    return '';
  }
  const neutralized = neutralizeBoundary(tokenizeRedacted(collapsed));
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
export function redactFreelancerValue(value: unknown): unknown {
  return redactSecrets(value);
}

/** Tokenizes a newline-delimited secret string (e.g. injected keys). */
function tokenizeRedacted(value: string): string {
  const normalized = value.trim();
  if (looksLikeSecret(normalized)) {
    return '[redacted-secret]';
  }
  return value;
}

const SECRET_LINE_RE =
  /^(api[_-]?key|password|token|secret|authorization|credential|client_secret|private[_-]?key)(\s*[=:]\s*\S+|:\s*\S+)$/i;

function looksLikeSecret(value: string): boolean {
  const singleLine = value.split(/\s+/).join(' ');
  if (singleLine.length < 8 || singleLine.length > 512) {
    return false;
  }
  if (SECRET_LINE_RE.test(singleLine)) {
    return true;
  }
  return isLikelySecret(singleLine);
}

/**
 * Cheap, deterministic indicator used ONLY for diagnostics and tests — never
 * the primary guard. Primary defense is treating all freelancer text as data
 * in the deterministic engine and never building prompts from it.
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
    'expose all freelancer',
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
    throw new FreelancerAIError(
      FREELANCER_AI_ERROR_CODES.PROMPT_INJECTION,
      'Request rejected: untrusted content contained injection indicators',
    );
  }
}

/** Bounded, redacted copy of a value for safe inclusion in a response. */
export function safeFreelancerValue(
  value: unknown,
  maxBytes = FREELANCER_SECURITY_MAX_VALUE_BYTES,
): unknown {
  const redacted = redactSecrets(value);
  return sanitizeRecursively(redacted, maxBytes);
}

/** True when a string still looks like a key/value secret line (diagnostic). */
export function looksLikeSecretKeyName(key: string): boolean {
  return isSecretKeyName(key);
}

function sanitizeRecursively(value: unknown, maxBytes: number): unknown {
  if (typeof value === 'string') {
    return sanitizeFreelancerText(value, maxBytes);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeRecursively(item, maxBytes));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = sanitizeRecursively(child, maxBytes);
    }
    return out;
  }
  return value;
}
