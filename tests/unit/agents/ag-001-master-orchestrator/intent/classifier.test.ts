import { describe, expect, it } from 'vitest';

import { RuleBasedIntentClassifier } from '../../../../../src/agents/ag-001-master-orchestrator/intent/classifiers/index.js';
import {
  IntentId,
  UserRole,
} from '../../../../../src/agents/ag-001-master-orchestrator/intent/types.js';

const classifier = new RuleBasedIntentClassifier();

describe('RuleBasedIntentClassifier', () => {
  it('classifies a clear create-project request', () => {
    const result = classifier.classify('please create a new project');

    expect(result.fallback).toBe(false);
    expect(result.primary.intent.id).toBe(IntentId.CREATE_PROJECT);
    expect(result.confidence).toBeGreaterThanOrEqual(0.55);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  it('returns high confidence for a saturated phrase match', () => {
    const result = classifier.classify('create project');

    expect(result.primary.intent.id).toBe(IntentId.CREATE_PROJECT);
    expect(result.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('finds the proposal intent', () => {
    const result = classifier.classify('I want to submit a proposal');

    expect(result.primary.intent.id).toBe(IntentId.SUBMIT_PROPOSAL);
  });

  it('detects the dispute intent in the admin category', () => {
    const result = classifier.classify('I need to open a dispute');

    expect(result.primary.intent.id).toBe(IntentId.OPEN_DISPUTE);
  });

  it('returns matched keywords and matched rules on the result', () => {
    const result = classifier.classify('create project');

    expect(result.matchedKeywords.length).toBeGreaterThan(0);
    expect(result.matchedRules.length).toBeGreaterThan(0);
    expect(result.primary.matchedKeywords).toEqual(result.matchedKeywords);
  });

  it('returns secondary intents for multi-intent input', () => {
    const result = classifier.classify('create project and send message');

    expect(result.secondary.length).toBeGreaterThan(0);
    expect(result.candidates.length).toBeGreaterThan(1);
  });

  it('populates metadata for every result', () => {
    const result = classifier.classify('create project');

    expect(result.metadata.classifier).toBe('rule-based');
    expect(result.metadata.inputLength).toBe('create project'.length);
    expect(result.metadata.thresholds.low).toBe(0.55);
    expect(result.metadata.thresholds.high).toBe(0.8);
  });
});

describe('fallback handling', () => {
  it('falls back to UNKNOWN for empty input', () => {
    const result = classifier.classify('   ');

    expect(result.fallback).toBe(true);
    expect(result.fallbackReason).toBe('empty');
    expect(result.primary.intent.id).toBe(IntentId.UNKNOWN);
  });

  it('falls back to UNKNOWN for an unmatched request', () => {
    const result = classifier.classify('xyzzy plugh nointent');

    expect(result.fallback).toBe(true);
    expect(result.fallbackReason).toBe('no-match');
    expect(result.primary.intent.id).toBe(IntentId.UNKNOWN);
  });

  it('falls back to low confidence for a single generic word', () => {
    const result = classifier.classify('help');

    expect(result.fallback).toBe(true);
    expect(result.fallbackReason).toBe('low-confidence');
    expect(result.primary.intent.id).toBe(IntentId.UNKNOWN);
  });
});

describe('role filtering', () => {
  it('keeps an intent the role may use', () => {
    const result = classifier.classify('create project', { role: UserRole.Freelancer });

    expect(result.primary.intent.id).toBe(IntentId.CREATE_PROJECT);
  });

  it('drops an intent the role may not use', () => {
    const result = classifier.classify('create project', { role: UserRole.Admin });

    expect(result.fallback).toBe(true);
    expect(result.primary.intent.id).toBe(IntentId.UNKNOWN);
  });
});

describe('max candidates', () => {
  it('respects an explicit candidate cap', () => {
    const result = classifier.classify('create project and send message', {
      maxCandidates: 1,
    });

    expect(result.candidates.length).toBeLessThanOrEqual(1);
    expect(result.secondary.length).toBe(0);
  });
});
