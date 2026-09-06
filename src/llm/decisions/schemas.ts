/**
 * Sprint 18 — Agentic Tool-Calling. Structured LLM decision contracts.
 *
 * Provider-independent by design: the reasoning layer may return a structured
 * decision (FINAL_RESPONSE | TOOL_CALL | CLARIFICATION_REQUIRED | ABORT) that
 * the agentic loop validates before any tool execution. These schemas describe
 * the *model contract* — what the agent instructs the model to emit. The loop
 * attaches its own correlation/turn ids; the model can never forge them.
 *
 * Extra envelope fields are rejected (strict) so malformed output degrades to a
 * controlled `TOOL_DECISION_INVALID` outcome instead of being interpreted.
 */

import { z } from 'zod';

/** Recursive JSON-compatible value accepted as tool arguments (no functions). */
export type LLMJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly LLMJsonValue[]
  | { readonly [key: string]: LLMJsonValue };

/** Recursive Zod schema for JSON-compatible values (no code, no cycles). */
export const LLMJsonSchema: z.ZodType<LLMJsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(LLMJsonSchema),
    z.record(z.string(), LLMJsonSchema),
  ]),
);

/** Structured tool arguments: a JSON object (schema validation happens in AG-004). */
export const ToolCallArgumentsSchema = z.record(z.string(), LLMJsonSchema);

/** Typed decision kinds a reasoning model may return. */
export enum ToolDecisionType {
  FinalResponse = 'FINAL_RESPONSE',
  ToolCall = 'TOOL_CALL',
  ClarificationRequired = 'CLARIFICATION_REQUIRED',
  Abort = 'ABORT',
}

/** Bounds applied to decision text fields (keeps model output bounded). */
export const DECISION_MAX_RESPONSE_LENGTH = 2048;
export const DECISION_MAX_QUESTION_LENGTH = 1024;
export const DECISION_MAX_REASON_LENGTH = 512;
export const DECISION_MAX_TOOL_NAME_LENGTH = 128;

/** A model-proposed tool call (parsed; ids are attached by the loop). */
export interface StructuredToolCall {
  readonly type: ToolDecisionType.ToolCall;
  readonly tool: string;
  readonly arguments: Readonly<Record<string, LLMJsonValue>>;
}

/** A final response decision. */
export interface StructuredFinalResponse {
  readonly type: ToolDecisionType.FinalResponse;
  readonly response: string;
}

/** A clarification decision. */
export interface StructuredClarification {
  readonly type: ToolDecisionType.ClarificationRequired;
  readonly question: string;
}

/** An abort decision (model declines the request). */
export interface StructuredAbort {
  readonly type: ToolDecisionType.Abort;
  readonly reason?: string;
}

/** The discriminated structured decision a model may emit. */
export type ToolDecision =
  StructuredToolCall | StructuredFinalResponse | StructuredClarification | StructuredAbort;

/** Zod schema for a model-proposed tool call (strict envelope). */
export const StructuredToolCallSchema = z
  .object({
    type: z.literal(ToolDecisionType.ToolCall),
    tool: z.string().trim().min(1).max(DECISION_MAX_TOOL_NAME_LENGTH),
    arguments: ToolCallArgumentsSchema,
  })
  .strict();

/** Zod schema for the full structured decision envelope (strict + bounded). */
export const ToolDecisionSchema: z.ZodType<ToolDecision> = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal(ToolDecisionType.FinalResponse),
      response: z.string().trim().min(1).max(DECISION_MAX_RESPONSE_LENGTH),
    })
    .strict(),

  StructuredToolCallSchema,

  z
    .object({
      type: z.literal(ToolDecisionType.ClarificationRequired),
      question: z.string().trim().min(1).max(DECISION_MAX_QUESTION_LENGTH),
    })
    .strict(),

  z
    .object({
      type: z.literal(ToolDecisionType.Abort),
      reason: z.string().trim().max(DECISION_MAX_REASON_LENGTH).optional(),
    })
    .strict(),
]);

/** Tools used to locate a JSON decision envelope inside model output. */
export const DECISION_OPEN_MARKER = '<decision>';
export const DECISION_CLOSE_MARKER = '</decision>';
export const DECISION_JSON_FENCE = '```json';
export const DECISION_FENCE = '```';

/** Safe summary of why a decision could not be parsed. */
export interface DecisionRejection {
  readonly reason: 'no_json_envelope' | 'invalid_json' | 'schema_mismatch' | 'decision_too_large';
  readonly detail: string;
}
