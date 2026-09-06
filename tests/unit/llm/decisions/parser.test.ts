import { describe, expect, it } from 'vitest';

import {
  parseStructuredDecision,
  extractDecisionEnvelope,
  isResponseWithinDecisionBounds,
  MAX_DECISION_PARSE_BYTES,
} from '../../../../src/llm/decisions/parser.js';
import {
  ToolDecisionType,
  DECISION_MAX_RESPONSE_LENGTH,
} from '../../../../src/llm/decisions/schemas.js';

describe('llm/decisions - structured decision parser (Sprint 18)', () => {
  it('parses a whole-output final response decision', () => {
    const outcome = parseStructuredDecision(
      JSON.stringify({ type: 'FINAL_RESPONSE', response: 'Here is your answer.' }),
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.decision.type).toBe(ToolDecisionType.FinalResponse);
      if (outcome.decision.type === ToolDecisionType.FinalResponse) {
        expect(outcome.decision.response).toBe('Here is your answer.');
      }
    }
  });

  it('parses a tool call decision inside a <decision> envelope', () => {
    const outcome = parseStructuredDecision(
      'Prefix text\n<decision>{"type":"TOOL_CALL","tool":"calculator","arguments":{"expression":"1+1"}}</decision>\nSuffix',
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.decision.type).toBe(ToolDecisionType.ToolCall);
      if (outcome.decision.type === ToolDecisionType.ToolCall) {
        expect(outcome.decision.tool).toBe('calculator');
        expect(outcome.decision.arguments).toEqual({ expression: '1+1' });
      }
    }
  });

  it('parses a clarification decision inside a ```json fenced block', () => {
    const outcome = parseStructuredDecision(
      '```json\n{"type":"CLARIFICATION_REQUIRED","question":"Which budget?"}\n```',
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.decision.type).toBe(ToolDecisionType.ClarificationRequired);
      if (outcome.decision.type === ToolDecisionType.ClarificationRequired) {
        expect(outcome.decision.question).toBe('Which budget?');
      }
    }
  });

  it('parses an abort decision with and without a reason', () => {
    const withReason = parseStructuredDecision('{"type":"ABORT","reason":"Out of scope"}');
    expect(withReason.ok).toBe(true);
    if (withReason.ok) {
      expect(withReason.decision.type).toBe(ToolDecisionType.Abort);
      if (withReason.decision.type === ToolDecisionType.Abort) {
        expect(withReason.decision.reason).toBe('Out of scope');
      }
    }

    const bare = parseStructuredDecision('{"type":"ABORT"}');
    expect(bare.ok).toBe(true);
    if (bare.ok) {
      expect(bare.decision.type).toBe(ToolDecisionType.Abort);
    }
  });

  it('trims/strips whitespace from envelope JSON', () => {
    const outcome = parseStructuredDecision('   {"type":"FINAL_RESPONSE","response":" ok "}   ');
    expect(outcome.ok).toBe(true);
  });

  it('rejects output with no recognizable envelope', () => {
    const outcome = parseStructuredDecision('Just plain prose, no JSON anywhere.');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.rejection.reason).toBe('no_json_envelope');
    }
  });

  it('rejects invalid JSON inside an envelope', () => {
    const outcome = parseStructuredDecision('{"type":"FINAL_RESPONSE","response":');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.rejection.reason).toBe('invalid_json');
    }
  });

  it('rejects unknown decision types (schema mismatch)', () => {
    const outcome = parseStructuredDecision('{"type":"EXPLOIT","payload":"x"}');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.rejection.reason).toBe('schema_mismatch');
    }
  });

  it('rejects extra fields strictly so unknown content is never interpreted', () => {
    const outcome = parseStructuredDecision(
      '{"type":"FINAL_RESPONSE","response":"ok","trailing":"extra"}',
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.rejection.reason).toBe('schema_mismatch');
    }
  });

  it('rejects oversized decision responses', () => {
    const tooLong = 'x'.repeat(DECISION_MAX_RESPONSE_LENGTH + 1);
    const outcome = parseStructuredDecision(
      JSON.stringify({ type: 'FINAL_RESPONSE', response: tooLong }),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.rejection.reason).toBe('schema_mismatch');
    }
  });

  it('rejects outputs exceeding the hard parse byte bound', () => {
    const blob = `{"type":"FINAL_RESPONSE","response":"${'y'.repeat(MAX_DECISION_PARSE_BYTES)}"}`;
    expect(Buffer.byteLength(blob, 'utf8')).toBeGreaterThan(MAX_DECISION_PARSE_BYTES);
    const outcome = parseStructuredDecision(blob);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.rejection.reason).toBe('no_json_envelope');
    }
  });

  it('extractDecisionEnvelope prefers whole JSON over delimited blocks', () => {
    expect(extractDecisionEnvelope('{"a":1}')).toBe('{"a":1}');
    expect(extractDecisionEnvelope('<decision>{"a":1}</decision>')).toBe('{"a":1}');
    expect(extractDecisionEnvelope('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractDecisionEnvelope('nothing here')).toBeUndefined();
    expect(extractDecisionEnvelope('')).toBeUndefined();
  });

  it('isResponseWithinDecisionBounds reports within-bound candidates', () => {
    expect(isResponseWithinDecisionBounds('short')).toBe(true);
    expect(isResponseWithinDecisionBounds('x'.repeat(DECISION_MAX_RESPONSE_LENGTH))).toBe(true);
    expect(isResponseWithinDecisionBounds('x'.repeat(DECISION_MAX_RESPONSE_LENGTH + 1))).toBe(
      false,
    );
  });
});
