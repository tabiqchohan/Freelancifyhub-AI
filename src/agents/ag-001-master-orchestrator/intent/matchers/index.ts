import type { IntentMatch, IntentMatcher, IntentRule } from '../types.js';
import { IntentId } from '../types.js';

const WORD_WEIGHT = 1;
const PHRASE_WEIGHT = 3;

function isPhrase(keyword: string): boolean {
  return /\s/.test(keyword);
}

function weight(keyword: string): number {
  return isPhrase(keyword) ? PHRASE_WEIGHT : WORD_WEIGHT;
}

/** Returns the ordered, lowercased set of words contained in the input. */
function tokenize(input: string): string[] {
  return input.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/**
 * Deterministic keyword matcher (prompt §4). Tokenises the input and matches a
 * keyword when every one of its words is present, so phrases tolerate filler
 * words ("submit a proposal" → "submit proposal"). No AI, no LLM, no API.
 */
export class KeywordMatcher implements IntentMatcher {
  readonly name = 'keyword-matcher';

  match(input: string, rules: readonly IntentRule[]): readonly IntentMatch[] {
    const tokens = new Set(tokenize(input));
    const results: IntentMatch[] = [];

    for (const rule of rules) {
      if (rule.intentId === IntentId.UNKNOWN) {
        continue;
      }

      const matchedKeywords: string[] = [];
      let matchedWeight = 0;

      for (const keyword of rule.keywords) {
        const words = tokenize(keyword);

        if (words.length > 0 && words.every((word) => tokens.has(word))) {
          matchedKeywords.push(keyword);
          matchedWeight += weight(keyword);
        }
      }

      if (matchedWeight > 0) {
        results.push({
          ruleId: rule.id,
          intentId: rule.intentId,
          matchedKeywords,
          matchedWeight,
        });
      }
    }

    return results;
  }
}
