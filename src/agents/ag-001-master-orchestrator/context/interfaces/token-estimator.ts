/**
 * Deterministic token-estimation abstraction (prompt §9). The estimator is a
 * replaceable seam: today we use a documented approximation; later a
 * model-specific tokenizer can be dropped in without changing callers.
 */

/** Contract any token estimator must satisfy. */
export interface TokenEstimator {
  /** Returns a deterministic token estimate for the given text. */
  estimate(text: string): number;
}

/**
 * Approximation estimator: ~4 characters per token (the common heuristic for
 * English text). Fully deterministic and free of external dependencies.
 */
export class CharacterTokenEstimator implements TokenEstimator {
  estimate(text: string): number {
    if (text.length === 0) {
      return 0;
    }
    return Math.ceil(text.length / 4);
  }
}
