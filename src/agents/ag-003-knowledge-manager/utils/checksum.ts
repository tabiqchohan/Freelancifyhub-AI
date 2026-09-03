import { createHash } from 'node:crypto';

/**
 * Deterministic content checksum (SHA-256 hex). Same input always produces
 * the same output. The hash is computed over the raw content bytes (UTF-8).
 */
export function computeContentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Compares two content hashes for equality. Returns false if either hash
 * is undefined or malformed.
 */
export function hashesMatch(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) {
    return false;
  }
  return a.length === b.length && a === b;
}
