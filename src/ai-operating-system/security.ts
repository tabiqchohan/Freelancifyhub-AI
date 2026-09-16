/**
 * Sprint 26 — AIOS boundary security.
 *
 * Fail-closed secret handling: inbound text and composed responses are scanned
 * for known secret/financial patterns; anything detected is blocked at the
 * boundary (or redacted from composed responses) so secrets never reach agent
 * logic or leave the AIOS in plain text.
 */

import { AiosError, AiosErrorCode } from './errors.js';

/** One detected secret occurrence inside a piece of text. */
export interface SecretMatch {
  readonly pattern: string;
  readonly index: number;
  readonly length: number;
}

export interface SecretScanResult {
  readonly detected: boolean;
  readonly matches: readonly SecretMatch[];
}

/** Known secret patterns watched at the boundary (fail-closed). */
const SECRET_PATTERNS: ReadonlyArray<{ readonly name: string; readonly re: RegExp }> = [
  { name: 'openai-api-key', re: /\bsk-[A-Za-z0-9]{16,}\b/g },
  { name: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'github-pat', re: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g },
  { name: 'stripe-secret-key', re: /\b(sk|pk)_(live|test)_[A-Za-z0-9]{16,}\b/g },
  { name: 'private-key-block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  {
    name: 'generic-secret',
    re: /\b(?:api[_-]?key|secret|token)\s*[:=]\s*["']?[A-Za-z0-9_-]{16,}["']?/gi,
  },
];

function scan(value: string): SecretScanResult {
  const matches: SecretMatch[] = [];
  for (const { name, re } of SECRET_PATTERNS) {
    for (const m of value.matchAll(re)) {
      matches.push({ pattern: name, index: m.index ?? 0, length: m[0].length });
    }
  }
  matches.sort((a, b) => a.index - b.index);
  return { detected: matches.length > 0, matches };
}

/** Scans inbound text; throws fail-closed when a secret is present. */
export function assertNoSecrets(text: string, enabled: boolean): void {
  if (!enabled) {
    return;
  }
  const result = scan(text);
  if (result.detected) {
    throw new AiosError(AiosErrorCode.SecretDetected, 'Inbound text contains a detected secret', {
      details: { patterns: result.matches.map((m) => m.pattern) },
    });
  }
}

/** Redacts any secret occurrences from composed output (never leaks). */
export function redactSecrets(text: string, enabled: boolean): string {
  if (!enabled) {
    return text;
  }
  let out = text;
  for (const { re } of SECRET_PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, () => '[REDACTED]');
  }
  return out;
}

/** True when the actor holds an Admin role (privilege gating uses this). */
export function isAdminRole(role: string): boolean {
  return role === 'Admin' || role === 'System';
}
