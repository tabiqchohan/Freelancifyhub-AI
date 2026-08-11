import type { ContextBuildWarning } from '../types/index.js';
import { ContextPriority, ContextSectionType, ContextSourceType } from '../types/index.js';
import { ContextBuildError, ContextValidationError } from '../errors/index.js';

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidMetadataValue(value: unknown): boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/** Returns a normalized priority or undefined if invalid. */
export function normalizePriority(value: unknown): ContextPriority | undefined {
  return Object.values(ContextPriority).find((priority) => priority === value);
}

/** Returns a normalized source type or undefined if invalid. */
export function normalizeSource(value: unknown): ContextSourceType | undefined {
  return Object.values(ContextSourceType).find((source) => source === value);
}

/** Returns a normalized section type or undefined if invalid. */
export function normalizeSection(value: unknown): ContextSectionType | undefined {
  return Object.values(ContextSectionType).find((section) => section === value);
}

/** Validates primitive-only metadata; returns true when valid. */
export function isValidMetadata(
  value: unknown,
): value is Readonly<Record<string, string | number | boolean>> {
  if (!isRecord(value)) {
    return false;
  }

  return Object.values(value).every(isValidMetadataValue);
}

/** Collects validation warnings for a single raw item. */
export function validateItemShape(item: unknown): {
  readonly ok: boolean;
  readonly warnings: readonly ContextBuildWarning[];
} {
  const warnings: ContextBuildWarning[] = [];

  if (!isRecord(item)) {
    return { ok: false, warnings: [itemShapeWarning()] };
  }

  if (typeof item.id !== 'string' || item.id.trim().length === 0) {
    warnings.push({
      code: 'INVALID_ITEM_ID',
      message: 'Context item has a missing or blank id',
      details: { itemId: item.id },
    });
  }

  if (typeof item.content !== 'string' || item.content.trim().length === 0) {
    warnings.push({
      code: 'INVALID_CONTENT',
      message: 'Context item has a missing or blank content',
      details: { itemId: typeof item.id === 'string' ? item.id : undefined },
    });
  }

  if (item.priority !== undefined && normalizePriority(item.priority) === undefined) {
    warnings.push({
      code: 'INVALID_PRIORITY',
      message: `Unknown context priority: ${String(item.priority)}`,
      details: { itemId: typeof item.id === 'string' ? item.id : undefined },
    });
  }

  if (item.source !== undefined && normalizeSource(item.source) === undefined) {
    warnings.push({
      code: 'INVALID_SOURCE',
      message: `Unknown context source: ${String(item.source)}`,
      details: { itemId: typeof item.id === 'string' ? item.id : undefined },
    });
  }

  if (item.section !== undefined && normalizeSection(item.section) === undefined) {
    warnings.push({
      code: 'INVALID_SECTION',
      message: `Unknown context section: ${String(item.section)}`,
      details: { itemId: typeof item.id === 'string' ? item.id : undefined },
    });
  }

  if (item.metadata !== undefined && !isValidMetadata(item.metadata)) {
    warnings.push({
      code: 'INVALID_METADATA',
      message: 'Context item metadata contains a non-primitive value',
      details: { itemId: typeof item.id === 'string' ? item.id : undefined },
    });
  }

  return { ok: warnings.length === 0, warnings };
}

/** Throws when a build request is structurally invalid (prompt §13). */
export function assertValidRequest(request: unknown): asserts request is {
  readonly requestId?: string;
  readonly traceId?: string;
  readonly items: readonly unknown[];
  readonly budget?: unknown;
} {
  if (!isRecord(request) || !Array.isArray(request.items)) {
    throw new ContextBuildError('Context build request must contain an items array');
  }
}

/** Throws when a supplied budget override is structurally invalid. */
export function assertValidBudget(budget: unknown): void {
  if (!isRecord(budget)) {
    return;
  }

  if (
    budget.maxTokens !== undefined &&
    (typeof budget.maxTokens !== 'number' || budget.maxTokens <= 0)
  ) {
    throw new ContextValidationError('Budget maxTokens must be a positive number');
  }
}

function itemShapeWarning(): ContextBuildWarning {
  return {
    code: 'INVALID_ITEM',
    message: 'Context item is not a valid object',
  };
}
