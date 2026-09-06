/**
 * Sprint 18 — Agentic Tool-Calling. Provider-independent tool decision parser.
 *
 * Accepts raw model output and converts it into a validated {@link ToolDecision}.
 * The parser is deliberately boring: it never executes code, never evaluates
 * arbitrary JavaScript, never shells out, and never interprets free-form prose
 * as commands. Malformed output becomes a controlled {@link DecisionRejection}.
 */

import { type z } from 'zod';

import {
  DECISION_CLOSE_MARKER,
  DECISION_FENCE,
  DECISION_JSON_FENCE,
  DECISION_OPEN_MARKER,
  DECISION_MAX_RESPONSE_LENGTH,
  ToolDecisionSchema,
  type DecisionRejection,
  type ToolDecision,
} from './schemas.js';

/** Hard bound on the text examined for a decision envelope (UTF-8 bytes). */
export const MAX_DECISION_PARSE_BYTES = 32 * 1024;

/** Outcome of parsing raw model output into a structured decision. */
export type StructuredDecisionOutcome =
  | { readonly ok: true; readonly decision: ToolDecision }
  | { readonly ok: false; readonly rejection: DecisionRejection };

/**
 * Extracts the JSON envelope from raw model output. Supported envelopes (in
 * priority order): an entire output that parses as JSON, a `<decision>…`
 * delimited block, or a ```json fenced block. Returns the raw JSON text to
 * parse, or undefined when nothing looks like a structured envelope.
 */
export function extractDecisionEnvelope(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (Buffer.byteLength(trimmed, 'utf8') > MAX_DECISION_PARSE_BYTES) {
    return undefined;
  }

  if (startsAsJson(trimmed)) {
    return trimmed;
  }

  const open = trimmed.indexOf(DECISION_OPEN_MARKER);
  if (open >= 0) {
    const close = trimmed.indexOf(DECISION_CLOSE_MARKER, open + DECISION_OPEN_MARKER.length);
    if (close > open) {
      const inner = trimmed.slice(open + DECISION_OPEN_MARKER.length, close).trim();
      if (inner.length > 0) {
        return inner;
      }
    }
  }

  const fenceIndex = trimmed.indexOf(DECISION_JSON_FENCE);
  if (fenceIndex >= 0) {
    const end = trimmed.indexOf(DECISION_FENCE, fenceIndex + DECISION_JSON_FENCE.length);
    if (end > fenceIndex) {
      const inner = trimmed.slice(fenceIndex + DECISION_JSON_FENCE.length, end).trim();
      if (inner.length > 0) {
        return inner;
      }
    }
  }

  return undefined;
}

/** True when the whole trimmed string appears to be a JSON document/object. */
function startsAsJson(value: string): boolean {
  const first = value[0];
  return first === '{' || first === '[';
}

/**
 * Parses raw model output into a validated {@link ToolDecision}. This is the
 * single trusted entry point the agentic loop calls for every model decision.
 */
export function parseStructuredDecision(raw: string): StructuredDecisionOutcome {
  const envelope = extractDecisionEnvelope(raw);
  if (envelope === undefined) {
    return {
      ok: false,
      rejection: {
        reason: 'no_json_envelope',
        detail: 'Model output did not contain a recognized structured decision envelope',
      },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(envelope) as unknown;
  } catch {
    return {
      ok: false,
      rejection: { reason: 'invalid_json', detail: 'Model output was not valid JSON' },
    };
  }

  const result = ToolDecisionSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      rejection: {
        reason: 'schema_mismatch',
        detail: summarizeIssues(result.error),
      },
    };
  }

  return { ok: true, decision: result.data };
}

/** Safe, bounded summary of zod issues (never includes raw payloads). */
function summarizeIssues(error: z.ZodError<z.infer<typeof ToolDecisionSchema>>): string {
  const issues = error.issues.slice(0, 5).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
    return `${path}: ${issue.message}`;
  });
  return issues.join('; ');
}

/** Reference bound used when pre-validating candidate responses. */
export function isResponseWithinDecisionBounds(candidate: string): boolean {
  return Buffer.byteLength(candidate, 'utf8') <= DECISION_MAX_RESPONSE_LENGTH;
}
