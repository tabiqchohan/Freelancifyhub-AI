# Intent Detection (AG-001 — Sprint 2)

Deterministic, interface-driven intent detection for the Master Orchestrator.
It is designed to be **fully replaceable** by an AI-powered classifier later.

## Architecture

```text
intent/
  types.ts        # IntentId enum, IntentDefinition, result types, contracts
  errors.ts       # IntentClassificationError / IntentRegistryError / IntentValidationError
  config.ts       # thresholds, features (env-driven, Zod-validated)
  validators.ts   # input / output / definition validation
  constants/      # keyword groups + per-intent keywords
  registry/       # IntentRegistry: official intent catalogue + duplicate detection
  rules/          # buildRules: registry keywords -> weighted IntentRule[]
  matchers/       # KeywordMatcher: deterministic substring/token matching
  classifiers/    # RuleBasedIntentClassifier: scoring, role filter, fallback
```

The flow is `Input → KeywordMatcher → RuleBasedIntentClassifier → IntentResult`.

## How the classifier works

1. **Normalise & match** — the input is lowercased and matched against every
   rule's keyword list. Phrase matches weigh more than single words
   (`WORD_WEIGHT = 1`, `PHRASE_WEIGHT = 2`).
2. **Score** — confidence is `min(1, matchedWeight / SATURATION_UNITS)` so a
   handful of concrete matches saturate to `1.0`.
3. **Filter** — optional role filtering drops intents the user role cannot use.
4. **Threshold** — a candidate qualifies only if
   `confidence >= max(intent.confidenceThreshold, INTENT_LOW_THRESHOLD)`.
5. **Rank & select** — qualifying candidates are sorted by confidence
   (tie-break by id); the top one is `primary`, the next `N-1` are `secondary`
   (multi-intent).
6. **Fallback** — no match / empty input / nothing above threshold returns the
   `UNKNOWN` intent with `fallback: true` and a `fallbackReason`
   (`empty` | `no-match` | `low-confidence`).

## How to add new intents

1. Add a member to `IntentId` in `types.ts`.
2. Add an entry in `IntentDefinition` in `registry/index.ts`
   (`buildDefaultDefinitions`): id, name, description, category, priority,
   allowed roles, confidence threshold, supported agents, status.
3. Add its keywords to `INTENT_KEYWORDS` in `constants/keywords.ts`.
4. (Optional) surface new keywords in the relevant `KEYWORD_GROUPS` bucket.

The registry constructor rejects duplicate intent IDs and keywords shared by
two intents, so additions are verified automatically.

## How to add keywords

Edit `INTENT_KEYWORDS` in `constants/keywords.ts`. Each intent must keep its own
distinct vocabulary — a keyword used by more than one intent raises an
`IntentRegistryError`. Keep `KEYWORD_GROUPS` as the human-facing, themed view.

## Future AI replacement strategy

The public contract is `IntentClassifier` (`name`, `version`, `classify`).
Today it is implemented by `RuleBasedIntentClassifier`. A future
`AiIntentClassifier` can implement the same interface and be substituted at the
composition root without changing callers or the registry. All results are
validated by `validateIntentResult` so both implementations guarantee the same
output shape.

## Design notes

- **No AI / LLM / API** — matching is deterministic and fully unit-testable.
- **No routing / memory / knowledge / tool / LLM / agent execution / context /
  response generation** — this sprint only classifies.
- Sprint 1 architecture is preserved untouched; this module composes with it
  (`nowIso`, the shared error hierarchy).
