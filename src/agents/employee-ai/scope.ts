import { EmployeeError, EmployeeErrorCode } from './errors.js';
import { EmployeeScopeTier } from './types.js';
import type { EmployeeScopeTierValue } from './types.js';

/**
 * Prompts17 Phase 18 — Scope filter. The employee only accepts work it can
 * genuinely execute inside its fail-closed workspace WITHOUT an external
 * sandboxed runner. Anything else is rejected up-front (fail-closed), matching
 * the prompt's explicit rule: do not fake a sandbox you do not have.
 */

const STATIC_KEYWORDS = [
  'landing',
  'landing page',
  'website',
  'web site',
  'site',
  'portfolio',
  'business site',
  'company site',
  'static',
  'marketing page',
  'product page',
  'service page',
  'homepage',
  'home page',
  'multi-page',
  'multipage',
];

const UNSUPPORTED_KEYWORDS = [
  'react',
  'next',
  'next.js',
  'vue',
  'angular',
  'svelte',
  'tailwind build',
  'package.json',
  'npm',
  'node_modules',
  'database',
  'login',
  'auth',
  'api',
  'backend',
  'serverless',
  'django',
  'rails',
  'laravel',
  'shopify',
  'wordpress',
  'e-commerce checkout',
  'payment',
  'stripe',
  'cms',
  'chatbot backend',
];

export interface ScopeDecision {
  readonly tier: EmployeeScopeTierValue;
  readonly reason: string;
  readonly requestedFeatures: ReadonlyArray<string>;
}

const toLower = (text: string): string => text.toLowerCase();

/**
 * Classifies a free-text client request. Conservative: a single unsupported
 * signal downgrades the whole request (a React/Next ask cannot be "partially"
 * served without those frameworks).
 */
export function classifyScope(requestText: string): ScopeDecision {
  const text = toLower(requestText.trim());
  if (text.length === 0) {
    return {
      tier: EmployeeScopeTier.UNSUPPORTED,
      reason: 'empty request',
      requestedFeatures: [],
    };
  }

  const requestedFeatures: string[] = [];
  for (const keyword of UNSUPPORTED_KEYWORDS) {
    if (text.includes(keyword)) {
      requestedFeatures.push(keyword);
      return {
        tier: EmployeeScopeTier.UNSUPPORTED,
        reason: `requested ${keyword}, which needs an execution sandbox this deployment does not provide`,
        requestedFeatures: [keyword],
      };
    }
  }

  const matched = STATIC_KEYWORDS.filter((keyword) => text.includes(keyword));
  requestedFeatures.push(...matched);
  if (matched.length === 0) {
    return {
      tier: EmployeeScopeTier.UNSUPPORTED,
      reason: 'no supported static-website signal found in the request',
      requestedFeatures: [],
    };
  }

  return {
    tier: EmployeeScopeTier.STATIC_SITE,
    reason: 'static website request that can be built deterministically in-workspace',
    requestedFeatures: matched.slice(0, 12),
  };
}

export function assertSupportedScope(requestText: string): EmployeeScopeTierValue {
  const decision = classifyScope(requestText);
  if (decision.tier !== EmployeeScopeTier.STATIC_SITE) {
    throw new EmployeeError(EmployeeErrorCode.UNSUPPORTED_SCOPE, decision.reason, {
      requestedFeatures: decision.requestedFeatures,
    });
  }
  return decision.tier;
}
