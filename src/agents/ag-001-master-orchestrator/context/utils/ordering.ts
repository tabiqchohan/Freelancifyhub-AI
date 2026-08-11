import { ContextPriority, ContextSectionType, ContextSourceType } from '../types/index.js';

/** Deterministic rank for priorities (lower = more important). */
export const PRIORITY_RANK: Readonly<Record<ContextPriority, number>> = {
  [ContextPriority.CRITICAL]: 0,
  [ContextPriority.HIGH]: 1,
  [ContextPriority.NORMAL]: 2,
  [ContextPriority.LOW]: 3,
  [ContextPriority.OPTIONAL]: 4,
};

/** Default stable ordering of context sections (prompt §12). */
export const DEFAULT_SECTION_ORDER: readonly ContextSectionType[] = [
  ContextSectionType.SYSTEM,
  ContextSectionType.REQUEST,
  ContextSectionType.USER,
  ContextSectionType.PROJECT,
  ContextSectionType.CONVERSATION,
  ContextSectionType.MEMORY,
  ContextSectionType.KNOWLEDGE,
  ContextSectionType.TOOL,
  ContextSectionType.AGENT,
];

/** Deterministic rank for sources (tie-break within the same priority). */
export const SOURCE_RANK: Readonly<Record<ContextSourceType, number>> = {
  [ContextSourceType.REQUEST]: 0,
  [ContextSourceType.SYSTEM]: 1,
  [ContextSourceType.USER]: 2,
  [ContextSourceType.PROJECT]: 3,
  [ContextSourceType.SESSION]: 4,
  [ContextSourceType.WORKSPACE]: 5,
  [ContextSourceType.MEMORY]: 6,
  [ContextSourceType.KNOWLEDGE]: 7,
  [ContextSourceType.TOOL]: 8,
  [ContextSourceType.AGENT]: 9,
};

/** Deterministic FNV-1a-ish hash used only for stable identity, not security. */
export function hashString(value: string): string {
  let hash = 2166136261;

  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Builds a stable content-identity key for deduplication. */
export function contentIdentityKey(content: string): string {
  return hashString(content.trim().toLowerCase());
}
