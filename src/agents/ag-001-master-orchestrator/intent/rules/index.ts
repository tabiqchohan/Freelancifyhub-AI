import type { IntentDefinition, IntentRule } from '../types.js';
import type { IntentRegistry } from '../registry/index.js';
import { IntentId } from '../types.js';

const WORD_WEIGHT = 1;
const PHRASE_WEIGHT = 2;

/** A keyword is treated as a phrase when it contains whitespace. */
function isPhrase(keyword: string): boolean {
  return /\s/.test(keyword);
}

/**
 * Builds {@link IntentRule}s from the registry. Phrase keywords carry more
 * weight than single words so deterministic confidence reflects specificity
 * (prompt §4/§6).
 */
export function buildRules(registry: IntentRegistry): readonly IntentRule[] {
  return registry.getAll().map((definition: IntentDefinition) => {
    const keywords = registry.getKeywords(definition.id);

    return {
      id: `rule:${definition.id}`,
      intentId: definition.id,
      keywords,
      keywordWeight: keywords.some(isPhrase) ? PHRASE_WEIGHT : WORD_WEIGHT,
    };
  });
}

/** Rule for the UNKNOWN intent, used as the fallback target (prompt §7). */
export function unknownRule(): IntentRule {
  return {
    id: `rule:${IntentId.UNKNOWN}`,
    intentId: IntentId.UNKNOWN,
    keywords: [],
    keywordWeight: WORD_WEIGHT,
  };
}
