import type { IntentConfig } from '../config.js';
import { intentConfig } from '../config.js';
import type {
  ClassifyOptions,
  IntentCandidate,
  IntentClassifier,
  IntentMetadata,
  IntentResult,
} from '../types.js';
import { IntentId } from '../types.js';
import { nowIso } from '../../utils/ids.js';
import { IntentClassificationError } from '../errors.js';
import { KeywordMatcher } from '../matchers/index.js';
import { IntentRegistry } from '../registry/index.js';
import { buildRules, unknownRule } from '../rules/index.js';

export const CLASSIFIER_NAME = 'rule-based';
export const CLASSIFIER_VERSION = '1.0.0';

const SATURATION_UNITS = 2;

function sortByConfidence(a: IntentCandidate, b: IntentCandidate): number {
  if (b.confidence !== a.confidence) {
    return b.confidence - a.confidence;
  }
  return a.intent.id.localeCompare(b.intent.id);
}

/**
 * Deterministic rule-based intent classifier (prompt §4/§6). Scores match
 * coverage against a saturation point, applies per-intent thresholds, honours
 * role filtering, and falls back to UNKNOWN on low/no confidence (prompt §7).
 * Fully replaceable in future by an AI classifier behind {@link IntentClassifier}.
 */
export class RuleBasedIntentClassifier implements IntentClassifier {
  readonly name = CLASSIFIER_NAME;
  readonly version = CLASSIFIER_VERSION;

  private readonly registry: IntentRegistry;
  private readonly matcher: KeywordMatcher;
  private readonly rules: ReturnType<typeof buildRules>;
  private readonly config: IntentConfig;

  constructor(
    registry: IntentRegistry = new IntentRegistry(),
    matcher: KeywordMatcher = new KeywordMatcher(),
    config: IntentConfig = intentConfig,
  ) {
    this.registry = registry;
    this.matcher = matcher;
    this.rules = buildRules(registry);
    this.config = config;
  }

  classify(input: string, options: ClassifyOptions = {}): IntentResult {
    const startedAt = Date.now();

    if (typeof input !== 'string' || input.trim().length === 0) {
      return this.unknownResult('empty', input, startedAt);
    }

    const matches = this.matcher.match(input, this.rules);

    if (matches.length === 0) {
      return this.unknownResult('no-match', input, startedAt);
    }

    const candidates = this.toCandidates(matches);
    const qualifying = candidates.filter((candidate) => this.qualifies(candidate, options));

    if (qualifying.length === 0) {
      return this.unknownResult('low-confidence', input, startedAt);
    }

    qualifying.sort(sortByConfidence);
    const primary = qualifying[0] as IntentCandidate;
    const maxCandidates = options.maxCandidates ?? this.config.INTENT_MAX_CANDIDATES;
    const secondary = qualifying.slice(1, maxCandidates);

    return {
      primary,
      secondary,
      candidates: qualifying.slice(0, maxCandidates),
      confidence: primary.confidence,
      matchedKeywords: primary.matchedKeywords,
      matchedRules: primary.matchedRules,
      fallback: false,
      metadata: this.metadata(input, startedAt),
    };
  }

  private toCandidates(
    matches: readonly {
      ruleId: string;
      intentId: IntentId;
      matchedKeywords: readonly string[];
      matchedWeight: number;
    }[],
  ): IntentCandidate[] {
    const candidates: IntentCandidate[] = [];

    for (const match of matches) {
      const intent = this.registry.get(match.intentId);

      if (intent === undefined || intent.id === IntentId.UNKNOWN) {
        continue;
      }

      candidates.push({
        intent,
        confidence: Math.min(1, match.matchedWeight / SATURATION_UNITS),
        matchedKeywords: [...match.matchedKeywords],
        matchedRules: [match.ruleId],
      });
    }

    return candidates;
  }

  private qualifies(candidate: IntentCandidate, options: ClassifyOptions): boolean {
    if (this.config.INTENT_ROLE_FILTERING_ENABLED && options.role !== undefined) {
      const allowed = (candidate.intent.allowedRoles as readonly string[]).includes(
        options.role as string,
      );

      if (!allowed) {
        return false;
      }
    }

    const intentThreshold = candidate.intent.confidenceThreshold;
    const minimum = Math.max(intentThreshold, this.config.INTENT_LOW_THRESHOLD);

    return candidate.confidence >= minimum;
  }

  private unknownResult(reason: string, input: string, startedAt: number): IntentResult {
    const fallback = this.fallbackCandidate();

    return {
      primary: fallback,
      secondary: [],
      candidates: [fallback],
      confidence: fallback.confidence,
      matchedKeywords: [],
      matchedRules: [],
      fallback: true,
      fallbackReason: reason,
      metadata: this.metadata(input, startedAt),
    };
  }

  private fallbackCandidate(): IntentCandidate {
    const unknown = this.registry.get(IntentId.UNKNOWN);

    if (unknown === undefined) {
      throw new IntentClassificationError('UNKNOWN intent is not registered');
    }

    return {
      intent: unknown,
      confidence: this.config.INTENT_FALLBACK_CONFIDENCE,
      matchedKeywords: [],
      matchedRules: [unknownRule().id],
    };
  }

  private metadata(input: string, startedAt: number): IntentMetadata {
    return {
      classifier: this.name,
      version: this.version,
      detectedAt: nowIso(),
      inputLength: input.length,
      elapsedMs: Date.now() - startedAt,
      thresholds: {
        high: this.config.INTENT_HIGH_THRESHOLD,
        low: this.config.INTENT_LOW_THRESHOLD,
      },
    };
  }
}
