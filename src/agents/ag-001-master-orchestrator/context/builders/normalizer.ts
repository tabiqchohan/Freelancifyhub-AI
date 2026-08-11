import type { ContextItem, ContextItemInput, ContextMetadata } from '../types/index.js';
import { ContextPriority } from '../types/index.js';
import type { ContextBuildWarning } from '../types/index.js';
import { normalizePriority, normalizeSection, normalizeSource } from '../validators/index.js';

const DEFAULT_PRIORITY = ContextPriority.NORMAL;

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

/**
 * Normalizes a raw input item into a valid {@link ContextItem}, assigning a
 * default priority when omitted and cleaning whitespace/source ids (prompt §6).
 * Returns undefined with a warning when the item is invalid.
 */
export function normalizeItem(
  raw: ContextItemInput,
  warnings: ContextBuildWarning[],
): ContextItem | undefined {
  const id = raw.id.trim();
  const content = normalizeText(raw.content);
  const priority = raw.priority === undefined ? DEFAULT_PRIORITY : raw.priority;

  if (id.length === 0) {
    warnings.push({ code: 'INVALID_ITEM_ID', message: 'Context item has a blank id' });
    return undefined;
  }

  if (content.length === 0) {
    warnings.push({
      code: 'INVALID_CONTENT',
      message: `Context item "${id}" has empty content`,
      itemId: id,
    });
    return undefined;
  }

  if (normalizePriority(priority) === undefined) {
    warnings.push({
      code: 'INVALID_PRIORITY',
      message: `Context item "${id}" has an invalid priority`,
      itemId: id,
    });
    return undefined;
  }

  const section = normalizeSection(raw.section);
  if (section === undefined) {
    warnings.push({
      code: 'INVALID_SECTION',
      message: `Context item "${id}" has an invalid section`,
      itemId: id,
    });
    return undefined;
  }

  const sourceType = normalizeSource(raw.source.type);
  if (sourceType === undefined) {
    warnings.push({
      code: 'INVALID_SOURCE',
      message: `Context item "${id}" has an invalid source type`,
      itemId: id,
    });
    return undefined;
  }

  const metadata = normalizeMetadata(raw.metadata);
  if (raw.metadata !== undefined && metadata === undefined) {
    warnings.push({
      code: 'INVALID_METADATA',
      message: `Context item "${id}" has invalid metadata`,
      itemId: id,
    });
    return undefined;
  }

  return {
    id,
    source: {
      type: sourceType,
      id: raw.source.id?.trim().length ? raw.source.id.trim() : undefined,
    },
    section,
    content,
    priority: normalizePriority(priority) as ContextPriority,
    metadata,
    order: raw.order,
  };
}

function normalizeMetadata(value: ContextMetadata | undefined): ContextMetadata | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized: Record<string, string | number | boolean> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean') {
      normalized[key] = typeof entry === 'string' ? entry.trim() : entry;
    } else {
      return undefined;
    }
  }

  return normalized;
}
