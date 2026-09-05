import { randomUUID } from 'node:crypto';

import type { IsoTimestamp, RequestId, TraceId } from '../types/index.js';
import { ToolValidationError } from '../errors/index.js';

/** Creates a canonical tool id: `tool:<name>:v<version>`. */
export function createToolId(name: string, version: string): string {
  return `tool:${name}:v${version}`;
}

/** Creates a tool version identifier for storage (`tver_<uuid>`). */
export function createToolVersionId(): string {
  return `tver_${randomUUID()}`;
}

/** Creates a unique execution id (`texec_<uuid>`). */
export function createExecutionId(): string {
  return `texec_${randomUUID()}`;
}

/** Creates a new correlation identifier. */
export function createTraceId(): TraceId {
  return `trace_${randomUUID()}`;
}

/** Creates a new request identifier. */
export function createRequestId(): RequestId {
  return `req_${randomUUID()}`;
}

/** Returns the current time as an ISO-8601 string. */
export function nowIso(): IsoTimestamp {
  return new Date().toISOString();
}

/** Allowed characters for a normalized tool name. */
const TOOL_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * Normalizes and validates a tool name. Lowercases, trims, and permits only
 * safe characters (lowercase letters, digits, underscore, hyphen). Rejects
 * empty, too-long, or unsafe names (prevents tool-name injection).
 */
export function normalizeToolName(raw: string): string {
  if (typeof raw !== 'string') {
    throw new ToolValidationError('Tool name must be a string', {
      code: 'INVALID_TOOL_NAME',
    });
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized.length === 0 || normalized.length > 64) {
    throw new ToolValidationError('Tool name must be 1-64 characters', {
      code: 'INVALID_TOOL_NAME',
      details: { length: normalized.length },
    });
  }
  if (!TOOL_NAME_PATTERN.test(normalized)) {
    throw new ToolValidationError(
      'Tool name may only contain lowercase letters, digits, underscore, hyphen',
      { code: 'INVALID_TOOL_NAME' },
    );
  }
  return normalized;
}

/** Validates a semantic version string (loose, safe). */
export function normalizeToolVersion(raw: string): string {
  if (typeof raw !== 'string') {
    throw new ToolValidationError('Tool version must be a string', {
      code: 'INVALID_TOOL_VERSION',
    });
  }
  const normalized = raw.trim();
  if (!/^\d+\.\d+\.\d+$/.test(normalized)) {
    throw new ToolValidationError('Tool version must match X.Y.Z', {
      code: 'INVALID_TOOL_VERSION',
    });
  }
  return normalized;
}
