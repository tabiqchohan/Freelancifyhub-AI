/**
 * Sprint 25 — Admin AI Team v1. Deterministic admin agents
 * (AG-501..AG-505 — catalog §14).
 *
 * Every admin agent is deterministic-first: it computes from its inputs and
 * supplied platform facts and never requires an LLM. Nothing is fabricated —
 * F21 analytics never invents metrics, fraud triage only reviews supplied
 * signals (never auto-bans, BR-ADM-2), health only reports observed
 * metrics/SLOs, AI operations never executes a config change (BR-ADM-4) and
 * executive insights only summarize supplied aggregated KPI facts (aggregated
 * only, never row-level PII). `insufficientData`/`dataSufficient` honestly
 * report when the supplied signal cannot support a claim. Privileged
 * recommendations are always stamped approval-required by the service via the
 * authorization module; the agents themselves never execute a privileged
 * write and treat memory/knowledge/tool output strictly as data.
 */

import type { AgentCapability } from '../ag-001-master-orchestrator/interfaces/index.js';
import {
  AgentCategory,
  AgentStatus,
  DependencyType,
} from '../ag-001-master-orchestrator/types/index.js';
import type {
  RuntimeAgent,
  RuntimeAgentExecutionContext,
  RuntimeAgentExecutionResult,
} from '../runtime/types.js';
import type { AgentDefinition } from '../agent-platform/types.js';
import { AgentExecutionMode, capability } from '../agent-platform/index.js';
import {
  ADMIN_AGENT_IDS,
  ADMIN_CAPABILITY_IDS,
  ADMIN_MAX_DOCUMENT_BYTES,
  ADMIN_MAX_KPIS,
  ADMIN_TEAM_GROUP,
  ADMIN_TEAM_VERSION,
} from './constants.js';
import { classifyAdminAction } from './authorization.js';
import { sanitizeAdminText } from './security.js';

/** One aggregated KPI fact as consumed by the analytics/executive agents. */
export interface AdminKpiFacts {
  readonly name: string;
  readonly value: number;
  readonly unit?: string;
  readonly period?: string;
  readonly note?: string;
}

/** Structured fields extracted from an admin task input (never invented). */
export interface AdminStructuredInput {
  readonly scopes: readonly string[];
  readonly action?: {
    readonly kind: string;
    readonly domain?: string;
    readonly target?: string;
    readonly reason?: string;
  };
  readonly analytics?: {
    readonly query?: string;
    readonly permittedDataset: readonly {
      readonly scope: string;
      readonly dataset: string;
    }[];
    readonly facts: readonly AdminKpiFacts[];
  };
  readonly fraud?: {
    readonly signals: readonly {
      readonly signalId: string;
      readonly signalType?: string;
      readonly severity?: string;
      readonly observedAt: string;
      readonly evidence: readonly { readonly label?: string; readonly detail?: string }[];
    }[];
    readonly policyScope?: string;
  };
  readonly health?: {
    readonly metrics: readonly {
      readonly name: string;
      readonly value: number;
      readonly unit?: string;
      readonly threshold?: number;
      readonly observedAt?: string;
    }[];
    readonly serviceTopology: readonly {
      readonly service: string;
      readonly healthy?: boolean;
    }[];
  };
  readonly aiops?: {
    readonly change?: {
      readonly changeType: 'feature-flag' | 'model-route' | 'prompt-version' | 'cost-cap';
      readonly target: string;
      readonly value?: string;
      readonly reversible?: boolean;
      readonly reason?: string;
    };
    readonly costFacts: readonly AdminKpiFacts[];
  };
  readonly executive?: {
    readonly kpis: readonly AdminKpiFacts[];
    readonly period?: string;
  };
}

/**
 * Extracts structured admin input from arbitrary execution inputs. Reads the
 * validated request input plus the `admin.scopes` allow-list carried by the
 * service so determinators can re-enforce role scopes at the agent level.
 */
export function extractAdminInput(inputs: Readonly<Record<string, unknown>>): AdminStructuredInput {
  const inline = (inputs['input'] as Readonly<Record<string, unknown>> | undefined) ?? inputs;
  const action = asObject(inputs['action']) ?? asObject(inline['action']);
  const analytics = asObject(inputs['analytics']) ?? asObject(inline['analytics']);
  const fraud = asObject(inputs['fraud']) ?? asObject(inline['fraud']);
  const health = asObject(inputs['health']) ?? asObject(inline['health']);
  const aiops = asObject(inputs['aiops']) ?? asObject(inline['aiops']);
  const executive = asObject(inputs['executive']) ?? asObject(inline['executive']);
  return {
    scopes: asStringArray(inputs['admin.scopes']) ?? [],
    action:
      action === undefined
        ? undefined
        : {
            kind: sanitizeRequired(action['kind']),
            domain: sanitizeOptional(action['domain']),
            target: sanitizeOptional(action['target']),
            reason: sanitizeOptional(action['reason']),
          },
    analytics:
      analytics === undefined
        ? undefined
        : {
            query: sanitizeOptional(analytics['query']),
            permittedDataset: asDatasetArray(analytics['permittedDataset']) ?? [],
            facts: asKpiFacts(analytics['facts']) ?? [],
          },
    fraud:
      fraud === undefined
        ? undefined
        : {
            signals: asSignalArray(fraud['signals']) ?? [],
            policyScope: sanitizeOptional(fraud['policyScope']),
          },
    health:
      health === undefined
        ? undefined
        : {
            metrics: asMetricArray(health['metrics']) ?? [],
            serviceTopology: asTopologyArray(health['serviceTopology']) ?? [],
          },
    aiops:
      aiops === undefined
        ? undefined
        : {
            change: asChangeObject(aiops['change']),
            costFacts: asKpiFacts(aiops['costFacts']) ?? [],
          },
    executive:
      executive === undefined
        ? undefined
        : {
            kpis: asKpiFacts(executive['kpis']) ?? [],
            period: sanitizeOptional(executive['period']),
          },
  };
}

// ---------------------------------------------------------------------------
// AG-501 — Analytics Agent (F21: deterministic data questions, no fabrication)
// ---------------------------------------------------------------------------

/** A measure the agent can deterministically define from a data question. */
export interface AnalyticsMeasure {
  readonly measure: string;
  readonly definition: string;
  readonly datasetScope: string;
}

/** Deterministic output of the analytics agent. */
export interface AnalyticsFinding {
  readonly dataSufficient: boolean;
  readonly query?: string;
  readonly queryComplexity: number;
  readonly measureDefinitions: readonly AnalyticsMeasure[];
  readonly chartKind?: 'bar' | 'line' | 'table';
  readonly datasetScopes: readonly string[];
  readonly scopeLimited: boolean;
  /** Row-level user data is never read (admin has no User-memory read). */
  readonly piiProtected: boolean;
  readonly aggregatedFacts: readonly AdminKpiFacts[];
  readonly note: string;
}

/** AG-501 — interpret an F21 data question deterministically; never invent numbers. */
export function analyzeAdminAnalytics(input: AdminStructuredInput): AnalyticsFinding {
  const analytics = input.analytics;
  const query = analytics?.query?.trim() ?? '';
  const facts = analytics?.facts ?? [];
  const requestedScopes = (analytics?.permittedDataset ?? []).map((entry) => entry.scope);
  const datasetScopes = requestedScopes.filter((scope) => input.scopes.includes(scope));
  const scopeLimited =
    requestedScopes.length > 0 && datasetScopes.length === requestedScopes.length;
  const queryWords = query.length > 0 ? query.split(/\s+/).filter(Boolean).length : 0;
  const dataSufficient = query.length > 0 || facts.length > 0;

  const measureDefinitions = dataSufficient ? inferMeasures(query) : [];
  const chartKind = inferChartKind(query, facts.length > 0);

  return {
    dataSufficient,
    query: query.length > 0 ? sanitizeAdminText(query, 2048) : undefined,
    queryComplexity: Math.min(queryWords, 64),
    measureDefinitions,
    chartKind,
    datasetScopes,
    scopeLimited,
    piiProtected: true,
    aggregatedFacts: facts.slice(0, ADMIN_MAX_KPIS),
    note: dataSufficient
      ? 'The query was interpreted into measure definitions deterministically; no platform metric is fabricated — actual values must come from the analytics pipeline (F21).'
      : 'Supply a data question and/or aggregated facts — the analytics agent never invents metrics.',
  };
}

function inferMeasures(query: string): readonly AnalyticsMeasure[] {
  const lower = query.toLowerCase();
  const measures: AnalyticsMeasure[] = [];
  if (/(user|signup|registration)/.test(lower)) {
    measures.push({
      measure: 'user.count',
      definition: 'Count of registered platform users within the permitted dataset scope.',
      datasetScope: 'users',
    });
  }
  if (/(conversion|converted)/.test(lower)) {
    measures.push({
      measure: 'conversion.rate',
      definition: 'Share of qualifying events that produced the target outcome.',
      datasetScope: 'projects',
    });
  }
  if (/(revenue|gross|payout|earnings)/.test(lower)) {
    measures.push({
      measure: 'revenue.gross',
      definition: 'Sum of approved platform value within the permitted dataset scope.',
      datasetScope: 'payments',
    });
  }
  if (/(project|gig|job|contract)/.test(lower)) {
    measures.push({
      measure: 'project.count',
      definition: 'Count of projects within the permitted dataset scope.',
      datasetScope: 'projects',
    });
  }
  if (/(dispute|escalat)/.test(lower)) {
    measures.push({
      measure: 'dispute.rate',
      definition: 'Share of projects that entered the dispute workflow.',
      datasetScope: 'disputes',
    });
  }
  if (/(fraud|scam)/.test(lower)) {
    measures.push({
      measure: 'fraud.rate',
      definition: 'Share of signals triaged as high risk within the observed window.',
      datasetScope: 'fraud',
    });
  }
  return measures.slice(0, 6);
}

function inferChartKind(query: string, hasFacts: boolean): 'bar' | 'line' | 'table' {
  if (/(over time|trend|timeline|weekly|monthly)/.test(query.toLowerCase())) {
    return 'line';
  }
  if (/(compare|versus|vs\.|vs )/.test(query.toLowerCase())) {
    return 'bar';
  }
  if (hasFacts) {
    return 'table';
  }
  return 'bar';
}

// ---------------------------------------------------------------------------
// AG-501 — Admin Action Analyzer (approval-gated advice; never execution)
// ---------------------------------------------------------------------------

/** Deterministic output of the generic admin action analyzer. */
export interface AdminActionAnalysis {
  readonly dataSufficient: boolean;
  readonly actionKind?: string;
  readonly mutating: boolean;
  readonly domains: readonly string[];
  readonly scopesRequired: readonly string[];
  readonly scopesAuthorized: readonly string[];
  readonly scopeLimited: boolean;
  /** BR-ADM-2: sensitive actions require two-admin approval. */
  readonly approvalsRequired: number;
  /** BR-ADM-3: audited with a fixed safe label. */
  readonly audited: boolean;
  /** Admin-AI never executes a privileged write from user text. */
  readonly executed: boolean;
  readonly note: string;
}

const DOMAIN_TO_SCOPE: Record<string, string> = {
  user: 'users',
  users: 'users',
  project: 'projects',
  projects: 'projects',
  payment: 'payments',
  payments: 'payments',
  refund: 'payments',
  dispute: 'disputes',
  disputes: 'disputes',
  fraud: 'fraud',
  ai: 'ai',
  config: 'ai',
};

/** AG-501 — classify a generic privileged request and gate it deterministically. */
export function analyzeAdminAction(input: AdminStructuredInput): AdminActionAnalysis {
  const action = input.action;
  if (action === undefined || action.kind.trim().length === 0) {
    return {
      dataSufficient: false,
      mutating: false,
      domains: [],
      scopesRequired: [],
      scopesAuthorized: [],
      scopeLimited: false,
      approvalsRequired: 0,
      audited: true,
      executed: false,
      note: 'Supply an action kind and, when relevant, a domain — approval-gated advice is deterministic and never executed.',
    };
  }
  const kind = action.kind.trim().slice(0, 64);
  const domain = action.domain?.trim().slice(0, 64) ?? '';
  const scopesRequired =
    domain.length > 0
      ? DOMAIN_TO_SCOPE[domain.toLowerCase()]
        ? [DOMAIN_TO_SCOPE[domain.toLowerCase()]!]
        : []
      : [];
  const scopesAuthorized = scopesRequired.filter((scope) => input.scopes.includes(scope));
  const mutating = classifyAdminAction(kind) === 'mutating';
  const scopeLimited = scopesRequired.length === 0 || scopesAuthorized.length > 0;
  return {
    dataSufficient: true,
    actionKind: kind,
    mutating,
    domains: domain.length > 0 ? [domain] : [],
    scopesRequired,
    scopesAuthorized,
    scopeLimited,
    approvalsRequired: mutating ? 2 : 0,
    audited: true,
    executed: false,
    note: mutating
      ? 'This is a mutating action — two-admin approval is required (BR-ADM-2); the admin AI only advises and never executes it.'
      : 'Read-style admin request assessed; observation is advisory only.',
  };
}

// ---------------------------------------------------------------------------
// AG-502 — Fraud Monitoring Agent (triage of supplied signals, no auto-ban)
// ---------------------------------------------------------------------------

/** Deterministic review of a single fraud signal. */
export interface SignalReview {
  readonly signalId: string;
  readonly signalType?: string;
  readonly severity: string;
  readonly riskLevel: 'low' | 'medium' | 'high';
  readonly evidenceCount: number;
  readonly slaDeadline?: string;
  readonly followUp: string;
}

/** Deterministic output of the fraud monitoring agent. */
export interface FraudTriage {
  readonly dataSufficient: boolean;
  readonly policyScope?: string;
  readonly reviewedSignals: readonly SignalReview[];
  readonly riskDistribution: readonly { readonly severity: string; readonly count: number }[];
  readonly highRiskCount: number;
  /** AC-22: every proposed action is audited and 2-admin approved. */
  readonly noAutoBans: boolean;
  readonly approvalRequired: boolean;
  readonly audited: boolean;
  readonly note: string;
}

const SLA_REVIEW_WINDOW_MS = 24 * 60 * 60 * 1000;

/** AG-502 — triage supplied fraud signals ONLY; never fabricate alerts or ban. */
export function analyzeAdminFraud(input: AdminStructuredInput): FraudTriage {
  const fraud = input.fraud;
  const signals = fraud?.signals ?? [];
  if (signals.length === 0) {
    return {
      dataSufficient: false,
      policyScope: fraud?.policyScope,
      reviewedSignals: [],
      riskDistribution: [],
      highRiskCount: 0,
      noAutoBans: true,
      approvalRequired: false,
      audited: true,
      note: 'No fraud signals were supplied — the agent cannot invent alerts or risk scores from nothing.',
    };
  }
  const reviewed: SignalReview[] = signals.slice(0, 20).map((signal) => {
    const riskLevel = riskLevelFor(signal.severity);
    return {
      signalId: sanitizeAdminText(signal.signalId, 64),
      signalType: signal.signalType,
      severity: signal.severity ?? riskLevel,
      riskLevel,
      evidenceCount: signal.evidence?.length ?? 0,
      slaDeadline: reviewDeadline(signal.observedAt),
      followUp:
        riskLevel === 'high'
          ? 'Escalate for two-admin approval before any ban or suspension (BR-ADM-2; AC-22 audit).'
          : riskLevel === 'medium'
            ? 'Queue for review within the SLA window.'
            : 'Informational — no automated action.',
    };
  });
  const distribution = [...new Set(reviewed.map((entry) => entry.severity))].map((severity) => ({
    severity,
    count: reviewed.filter((entry) => entry.severity === severity).length,
  }));
  const highRiskCount = reviewed.filter((entry) => entry.riskLevel === 'high').length;
  return {
    dataSufficient: true,
    policyScope: fraud?.policyScope,
    reviewedSignals: reviewed,
    riskDistribution: distribution,
    highRiskCount,
    noAutoBans: true,
    approvalRequired: highRiskCount > 0,
    audited: true,
    note: `${reviewed.length} supplied signal${reviewed.length === 1 ? '' : 's'} triaged deterministically; ${highRiskCount} high risk${highRiskCount === 1 ? '' : 's'}. No automated ban is ever executed (BR-ADM-2).`,
  };
}

function riskLevelFor(severity: string | undefined): 'low' | 'medium' | 'high' {
  const value = severity?.toLowerCase() ?? '';
  if (value === 'critical' || value === 'high') {
    return 'high';
  }
  if (value === 'medium') {
    return 'medium';
  }
  return 'low';
}

function reviewDeadline(observedAt: string): string | undefined {
  const epoch = Date.parse(observedAt);
  if (!Number.isFinite(epoch)) {
    return undefined;
  }
  return new Date(epoch + SLA_REVIEW_WINDOW_MS).toISOString();
}

// ---------------------------------------------------------------------------
// AG-503 — Platform Health Agent (observed SLO/metric facts only)
// ---------------------------------------------------------------------------

/** One deterministic metric status. */
export interface MetricStatus {
  readonly name: string;
  readonly observed: number;
  readonly unit?: string;
  readonly threshold?: number;
  readonly status: 'ok' | 'warn' | 'breach' | 'n/a';
}

/** One deterministic service status. */
export interface ServiceStatus {
  readonly service: string;
  readonly healthy: boolean;
  readonly status: 'ok' | 'down';
}

/** Deterministic output of the platform health agent. */
export interface HealthAssessment {
  readonly dataSufficient: boolean;
  readonly metrics: readonly MetricStatus[];
  readonly breaches: readonly string[];
  readonly topology: readonly ServiceStatus[];
  readonly incidents: readonly string[];
  readonly degraded: boolean;
  readonly note: string;
}

/** AG-503 — assess observed platform metrics; every value must be supplied. */
export function analyzeAdminHealth(input: AdminStructuredInput): HealthAssessment {
  const health = input.health;
  const metrics = health?.metrics ?? [];
  const topology = health?.serviceTopology ?? [];
  if (metrics.length === 0 && topology.length === 0) {
    return {
      dataSufficient: false,
      metrics: [],
      breaches: [],
      topology: [],
      incidents: [],
      degraded: false,
      note: 'No platform metrics or service topology were supplied — health status cannot be derived from nothing.',
    };
  }
  const statuses: MetricStatus[] = metrics.slice(0, 20).map((metric) => {
    const threshold = metric.threshold;
    let status: MetricStatus['status'] = 'ok';
    if (threshold === undefined) {
      status = 'n/a';
    } else if (metric.value > threshold) {
      status = 'breach';
    } else if (metric.value >= threshold * 0.8) {
      status = 'warn';
    }
    return {
      name: sanitizeAdminText(metric.name, 128),
      observed: metric.value,
      unit: metric.unit,
      threshold,
      status,
    };
  });
  const breaches = statuses.filter((entry) => entry.status === 'breach').map((entry) => entry.name);
  const services: ServiceStatus[] = topology.slice(0, 10).map((entry) => ({
    service: sanitizeAdminText(entry.service, 128),
    healthy: entry.healthy ?? false,
    status: entry.healthy === true ? 'ok' : 'down',
  }));
  const incidents = services
    .filter((entry) => entry.status === 'down')
    .map((entry) => entry.service);
  return {
    dataSufficient: true,
    metrics: statuses,
    breaches,
    topology: services,
    incidents,
    degraded: breaches.length > 0 || incidents.length > 0,
    note:
      breaches.length > 0 || incidents.length > 0
        ? `Degraded: ${breaches.length} metric breach${breaches.length === 1 ? '' : 'es'}, ${incidents.length} service incident${incidents.length === 1 ? '' : 's'}.`
        : 'Reported metrics are within thresholds; monitoring remains advisory for humans.',
  };
}

// ---------------------------------------------------------------------------
// AG-504 — AI Operations Agent (reversible proposals; never execution)
// ---------------------------------------------------------------------------

/** One rollout step in an AI-ecosystem change plan (advisory). */
export interface RolloutStep {
  readonly step: string;
  readonly action: string;
  readonly reversible: boolean;
}

/** Deterministic output of the AI operations agent. */
export interface AiOpsAssessment {
  readonly dataSufficient: boolean;
  readonly changeType?: string;
  readonly changeTarget?: string;
  readonly rolloutPlan: readonly RolloutStep[];
  /** BR-ADM-4: changes are feature-flagged and reversible by default. */
  readonly reversible: boolean;
  /** BR-ADM-2: config changes always require explicit approval. */
  readonly approvalRequired: boolean;
  readonly audited: boolean;
  readonly executed: boolean;
  readonly costFacts: readonly AdminKpiFacts[];
  readonly note: string;
}

/** AG-504 — review a proposed AI-ecosystem change; never apply it. */
export function analyzeAdminAiOps(input: AdminStructuredInput): AiOpsAssessment {
  const aiops = input.aiops;
  const change = aiops?.change;
  const costFacts = aiops?.costFacts ?? [];
  if (change === undefined && costFacts.length === 0) {
    return {
      dataSufficient: false,
      rolloutPlan: [],
      reversible: true,
      approvalRequired: false,
      audited: true,
      executed: false,
      costFacts: [],
      note: 'No AI-ecosystem change proposal or cost facts were supplied — nothing is proposed or modified.',
    };
  }
  const reversible = change?.reversible ?? true;
  const rolloutPlan: RolloutStep[] = [
    {
      step: 'feature-flag',
      action: `Enable "${change?.target ?? 'target'}" behind a feature flag — reversible by default (BR-ADM-4).`,
      reversible: true,
    },
    {
      step: 'canary',
      action: 'Roll out to a small cohort first; observe before widening.',
      reversible: true,
    },
    {
      step: 'monitor',
      action: 'Watch cost/latency/quality metrics during the rollout.',
      reversible: true,
    },
    {
      step: 'rollback-ready',
      action: 'Keep a documented rollback path in place for the full window.',
      reversible: true,
    },
  ];
  return {
    dataSufficient: true,
    changeType: change?.changeType,
    changeTarget: sanitizeAdminText(change?.target ?? '', 128),
    rolloutPlan,
    reversible,
    approvalRequired: change !== undefined,
    audited: true,
    executed: false,
    costFacts: costFacts.slice(0, ADMIN_MAX_KPIS),
    note:
      change !== undefined
        ? 'Change proposal assessed as a reversible, feature-flagged rollout — approval is required and nothing is executed by the AI (BR-ADM-2/4).'
        : 'Cost facts reported only; no change was proposed.',
  };
}

// ---------------------------------------------------------------------------
// AG-505 — Executive Insights Agent (aggregated KPI facts only)
// ---------------------------------------------------------------------------

/** One deterministic KPI report entry. */
export interface KpiReport {
  readonly name: string;
  readonly value: number;
  readonly unit?: string;
  readonly period?: string;
  readonly direction: 'up' | 'down' | 'flat';
  readonly flagged: boolean;
}

/** Deterministic output of the executive insights agent. */
export interface ExecutiveReview {
  readonly dataSufficient: boolean;
  /** Inputs are aggregated KPI facts by contract — row-level data is rejected. */
  readonly aggregatedOnly: boolean;
  readonly period?: string;
  readonly kpis: readonly KpiReport[];
  readonly anomalies: readonly string[];
  readonly piiFree: boolean;
  readonly note: string;
}

/** AG-505 — summarize supplied aggregated KPI facts; never invent totals. */
export function analyzeAdminExecutive(input: AdminStructuredInput): ExecutiveReview {
  const executive = input.executive;
  const kpis = executive?.kpis ?? [];
  if (kpis.length === 0) {
    return {
      dataSufficient: false,
      aggregatedOnly: true,
      period: executive?.period,
      kpis: [],
      anomalies: [],
      piiFree: true,
      note: 'No aggregated KPI facts were supplied — executive insights never fabricate platform totals.',
    };
  }
  const reports: KpiReport[] = kpis.slice(0, ADMIN_MAX_KPIS).map((kpi) => {
    const lowerNote = (kpi.note ?? '').toLowerCase();
    const direction: KpiReport['direction'] = /(up|increas|grew|rise|positive)/.test(lowerNote)
      ? 'up'
      : /(down|decreas|fell|negative)/.test(lowerNote)
        ? 'down'
        : 'flat';
    const flagged = /(anomaly|critical|alert|attention)/.test(lowerNote);
    return {
      name: sanitizeAdminText(kpi.name, 128),
      value: kpi.value,
      unit: kpi.unit,
      period: kpi.period,
      direction,
      flagged,
    };
  });
  const anomalies = reports.filter((entry) => entry.flagged).map((entry) => entry.name);
  return {
    dataSufficient: true,
    aggregatedOnly: true,
    period: executive?.period,
    kpis: reports,
    anomalies,
    piiFree: true,
    note:
      anomalies.length > 0
        ? `Executive review compiled from ${reports.length} aggregated KPI fact${reports.length === 1 ? '' : 's'}; ${anomalies.length} flagged for attention. Row-level data is never exposed.`
        : `Executive review compiled from ${reports.length} aggregated KPI fact${reports.length === 1 ? '' : 's'}; row-level data is never exposed.`,
  };
}

// ---------------------------------------------------------------------------
// Runtime agents
// ---------------------------------------------------------------------------

const DEP = (id: string) => ({ type: DependencyType.Agent, id, required: false });

function adminCapabilities(ids: readonly string[]): readonly AgentCapability[] {
  return Object.freeze(ids.map((id) => ({ id, name: id, enabled: true })));
}

/** A deterministic per-capability analyzer shared by the runtime agents. */
type AdminAnalyzer = (
  capabilityId: string,
  input: AdminStructuredInput,
) => {
  readonly output: Readonly<Record<string, unknown>>;
  readonly recommendations: readonly unknown[];
};

interface AdminAgentConfig {
  readonly agentId: string;
  readonly name: string;
  readonly category: AgentCategory;
  readonly status: AgentStatus;
  readonly capabilities: readonly string[];
  readonly dependencies: readonly string[];
  readonly maxTokens: number;
}

function createAdminAgent(config: AdminAgentConfig): RuntimeAgent {
  const { agentId } = config;
  return {
    configuration: {
      agentId,
      name: config.name,
      version: ADMIN_TEAM_VERSION,
      category: config.category,
      status: config.status,
      capabilities: adminCapabilities(config.capabilities),
      dependencies: Object.freeze(config.dependencies.map(DEP)),
      limits: { maxTokens: config.maxTokens, maxAttempts: 2 },
    },
    availability: { available: true },
    async execute(context: RuntimeAgentExecutionContext): Promise<RuntimeAgentExecutionResult> {
      if (context.signal.requested) {
        return cancelled(agentId);
      }
      const delay = clampDelay(parseNumber(context.inputs['admin.delayMs'], 0));
      if (delay > 0) {
        await wait(delay, context);
      }
      if (context.signal.requested) {
        return cancelled(agentId);
      }
      const input = extractAdminInput(context.inputs);
      const capabilityId = resolveCapability(
        agentId,
        config.capabilities,
        context.inputs['admin.capability'],
      );
      const { output, recommendations } = dispatchAnalyzer(agentId, capabilityId, input);
      return {
        success: true,
        output: {
          ...output,
          recommendations,
        },
        metadata: { provider: 'runtime', agentId, version: ADMIN_TEAM_VERSION },
      };
    },
  };
}

/** Picks the requested capability when the agent advertises it; else primary. */
function resolveCapability(
  agentId: string,
  allowed: readonly string[],
  requested: unknown,
): string {
  if (typeof requested === 'string' && requested.length > 0 && allowed.includes(requested)) {
    return requested;
  }
  return defaultCapabilityFor(agentId);
}

// ---------------------------------------------------------------------------
// Capability-aware analyzer dispatch
// ---------------------------------------------------------------------------

/** Result key used per capability in agent output. */
export const ADMIN_CAPABILITY_KEYS: Readonly<Record<string, string>> = Object.freeze({
  [ADMIN_CAPABILITY_IDS.action]: 'action',
  [ADMIN_CAPABILITY_IDS.analytics]: 'analytics',
  [ADMIN_CAPABILITY_IDS.fraud]: 'fraud',
  [ADMIN_CAPABILITY_IDS.health]: 'health',
  [ADMIN_CAPABILITY_IDS.aiOps]: 'aiops',
  [ADMIN_CAPABILITY_IDS.executive]: 'executive',
});

function wrapOutput(
  capabilityId: string,
  result: Record<string, unknown>,
  recommendations: readonly unknown[],
): { readonly output: Record<string, unknown>; readonly recommendations: readonly unknown[] } {
  const key = ADMIN_CAPABILITY_KEYS[capabilityId] ?? 'result';
  return { output: { [key]: result[key] ?? result }, recommendations };
}

function analyzeActionOutput(
  capabilityId: string,
  input: AdminStructuredInput,
): { readonly output: Record<string, unknown>; readonly recommendations: readonly unknown[] } {
  const action = analyzeAdminAction(input);
  const recommendations: unknown[] = action.dataSufficient
    ? [
        {
          recommendation: action.mutating
            ? 'Sensitive action classified and approval-gated — two-admin approval required (BR-ADM-2); nothing is executed.'
            : 'Read-style request classified as advisory; no automated action taken.',
          actionKind: action.mutating ? 'mutating' : 'read',
          capability: capabilityId,
          priority: action.mutating ? 'high' : 'low',
        },
      ]
    : [];
  return wrapOutput(capabilityId, { action }, recommendations);
}

function analyzeAnalyticsOutput(
  capabilityId: string,
  input: AdminStructuredInput,
): { readonly output: Record<string, unknown>; readonly recommendations: readonly unknown[] } {
  const analytics = analyzeAdminAnalytics(input);
  const recommendations: unknown[] = analytics.dataSufficient
    ? []
    : [
        {
          recommendation:
            'Supply a data question and/or aggregated facts to run the analytics review.',
        },
      ];
  if (analytics.measureDefinitions.length === 0 && analytics.dataSufficient) {
    recommendations.push({
      recommendation:
        'Add measurable terms (user, conversion, revenue, project, dispute, fraud) to derive measure definitions.',
    });
  }
  return wrapOutput(capabilityId, { analytics }, recommendations);
}

function analyzeFraudOutput(
  capabilityId: string,
  input: AdminStructuredInput,
): { readonly output: Record<string, unknown>; readonly recommendations: readonly unknown[] } {
  const fraud = analyzeAdminFraud(input);
  const recommendations = fraudRecommendations(fraud, capabilityId);
  return wrapOutput(capabilityId, { fraud }, recommendations);
}

function fraudRecommendations(fraud: FraudTriage, capabilityId: string): readonly unknown[] {
  const out: unknown[] = [];
  if (!fraud.dataSufficient) {
    out.push({ recommendation: 'Supply fraud signals to triage — alerts are never fabricated.' });
    return out;
  }
  for (const signal of fraud.reviewedSignals) {
    if (signal.riskLevel === 'high') {
      out.push({
        recommendation: `Signal ${signal.signalId} requires two-admin approval before any action (BR-ADM-2; AC-22 audit).`,
        actionKind: 'mutating',
        capability: capabilityId,
        priority: 'high',
      });
    }
  }
  return out.slice(0, 6);
}

function analyzeHealthOutput(
  capabilityId: string,
  input: AdminStructuredInput,
): { readonly output: Record<string, unknown>; readonly recommendations: readonly unknown[] } {
  const health = analyzeAdminHealth(input);
  const recommendations: unknown[] = !health.dataSufficient
    ? [
        {
          recommendation:
            'Supply observed platform metrics and service topology to assess platform health.',
        },
      ]
    : [];
  for (const breach of health.breaches) {
    recommendations.push({
      recommendation: `Metric breach on "${breach}" — route to the on-call human for review.`,
      priority: 'high',
      capability: capabilityId,
    });
  }
  for (const incident of health.incidents) {
    recommendations.push({
      recommendation: `Service incident on "${incident}" — acknowledge and escalate to the platform team.`,
      priority: 'high',
      capability: capabilityId,
    });
  }
  return wrapOutput(capabilityId, { health }, recommendations.slice(0, 6));
}

function analyzeAiOpsOutput(
  capabilityId: string,
  input: AdminStructuredInput,
): { readonly output: Record<string, unknown>; readonly recommendations: readonly unknown[] } {
  const aiops = analyzeAdminAiOps(input);
  const recommendations: unknown[] = !aiops.dataSufficient
    ? [
        {
          recommendation:
            'Supply an AI-ecosystem change proposal or cost facts to assess operations.',
        },
      ]
    : [];
  if (aiops.changeType !== undefined) {
    recommendations.push({
      recommendation:
        'Approval required before applying the change; rollout must stay feature-flagged and reversible (BR-ADM-2/4).',
      actionKind: 'mutating',
      capability: capabilityId,
      priority: 'high',
    });
  }
  for (const cost of aiops.costFacts) {
    const lowerNote = (cost.note ?? '').toLowerCase();
    if (/(anomaly|spike|critical)/.test(lowerNote)) {
      recommendations.push({
        recommendation: `Cost anomaly flagged on "${cost.name}" — review before any budget change.`,
        priority: 'high',
        capability: capabilityId,
      });
    }
  }
  return wrapOutput(capabilityId, { aiops }, recommendations.slice(0, 6));
}

function analyzeExecutiveOutput(
  capabilityId: string,
  input: AdminStructuredInput,
): { readonly output: Record<string, unknown>; readonly recommendations: readonly unknown[] } {
  const executive = analyzeAdminExecutive(input);
  const recommendations: unknown[] = !executive.dataSufficient
    ? [
        {
          recommendation:
            'Supply aggregated KPI facts to compile an executive review — totals are never invented.',
        },
      ]
    : [];
  for (const anomaly of executive.anomalies) {
    recommendations.push({
      recommendation: `KPI "${anomaly}" flagged for attention in the executive review.`,
      priority: 'medium',
      capability: capabilityId,
    });
  }
  return wrapOutput(capabilityId, { executive }, recommendations.slice(0, 6));
}

/** Full capability → analyzer dispatch used by all create* agents. */
const ADMIN_ANALYZERS: Readonly<Record<string, AdminAnalyzer>> = Object.freeze({
  [ADMIN_CAPABILITY_IDS.action]: analyzeActionOutput,
  [ADMIN_CAPABILITY_IDS.analytics]: analyzeAnalyticsOutput,
  [ADMIN_CAPABILITY_IDS.fraud]: analyzeFraudOutput,
  [ADMIN_CAPABILITY_IDS.health]: analyzeHealthOutput,
  [ADMIN_CAPABILITY_IDS.aiOps]: analyzeAiOpsOutput,
  [ADMIN_CAPABILITY_IDS.executive]: analyzeExecutiveOutput,
});

/** AG-501 — Analytics Agent (F21; data questions, no fabricated metrics). */
export function createAnalyticsAgent(): RuntimeAgent {
  const agentId = ADMIN_AGENT_IDS.analytics;
  return createAdminAgent({
    agentId,
    name: 'Analytics Agent',
    category: AgentCategory.Admin,
    status: AgentStatus.InDevelopment,
    capabilities: [ADMIN_CAPABILITY_IDS.analytics, ADMIN_CAPABILITY_IDS.action],
    dependencies: [],
    maxTokens: 6000,
  });
}

/** AG-502 — Fraud Monitoring Agent (triage; no auto-ban, BR-ADM-2). */
export function createFraudMonitoringAgent(): RuntimeAgent {
  const agentId = ADMIN_AGENT_IDS.fraudMonitoring;
  return createAdminAgent({
    agentId,
    name: 'Fraud Monitoring Agent',
    category: AgentCategory.Admin,
    status: AgentStatus.InDevelopment,
    capabilities: [ADMIN_CAPABILITY_IDS.fraud],
    dependencies: [ADMIN_AGENT_IDS.analytics],
    maxTokens: 6000,
  });
}

/** AG-503 — Platform Health Agent (observed SLO tracking only). */
export function createPlatformHealthAgent(): RuntimeAgent {
  const agentId = ADMIN_AGENT_IDS.platformHealth;
  return createAdminAgent({
    agentId,
    name: 'Platform Health Agent',
    category: AgentCategory.Admin,
    status: AgentStatus.Draft,
    capabilities: [ADMIN_CAPABILITY_IDS.health],
    dependencies: [ADMIN_AGENT_IDS.analytics],
    maxTokens: 5000,
  });
}

/** AG-504 — AI Operations Agent (reversible proposals only, BR-ADM-4). */
export function createAiOperationsAgent(): RuntimeAgent {
  const agentId = ADMIN_AGENT_IDS.aiOperations;
  return createAdminAgent({
    agentId,
    name: 'AI Operations Agent',
    category: AgentCategory.Admin,
    status: AgentStatus.Draft,
    capabilities: [ADMIN_CAPABILITY_IDS.aiOps],
    dependencies: [ADMIN_AGENT_IDS.analytics],
    maxTokens: 5000,
  });
}

/** AG-505 — Executive Insights Agent (aggregated KPI summaries only). */
export function createExecutiveInsightsAgent(): RuntimeAgent {
  const agentId = ADMIN_AGENT_IDS.executive;
  return createAdminAgent({
    agentId,
    name: 'Executive Insights Agent',
    category: AgentCategory.Admin,
    status: AgentStatus.Draft,
    capabilities: [ADMIN_CAPABILITY_IDS.executive],
    dependencies: [
      ADMIN_AGENT_IDS.analytics,
      ADMIN_AGENT_IDS.fraudMonitoring,
      ADMIN_AGENT_IDS.platformHealth,
    ],
    maxTokens: 6000,
  });
}

/** All admin-team runtime agents introduced by this module. */
export function createAdminTeamAgents(): readonly RuntimeAgent[] {
  return [
    createAnalyticsAgent(),
    createFraudMonitoringAgent(),
    createPlatformHealthAgent(),
    createAiOperationsAgent(),
    createExecutiveInsightsAgent(),
  ];
}

/** Dispatches to the analyzer for the selected capability (or primary fallback). */
function dispatchAnalyzer(
  agentId: string,
  capabilityId: string,
  input: AdminStructuredInput,
): { readonly output: Record<string, unknown>; readonly recommendations: readonly unknown[] } {
  const resolver = ADMIN_ANALYZERS[capabilityId];
  if (resolver === undefined) {
    throw new Error(`No admin analyzer for capability ${capabilityId} on ${agentId}`);
  }
  return resolver(capabilityId, input);
}

function defaultCapabilityFor(agentId: string): string {
  switch (agentId) {
    case ADMIN_AGENT_IDS.analytics:
      return ADMIN_CAPABILITY_IDS.analytics;
    case ADMIN_AGENT_IDS.fraudMonitoring:
      return ADMIN_CAPABILITY_IDS.fraud;
    case ADMIN_AGENT_IDS.platformHealth:
      return ADMIN_CAPABILITY_IDS.health;
    case ADMIN_AGENT_IDS.aiOperations:
      return ADMIN_CAPABILITY_IDS.aiOps;
    case ADMIN_AGENT_IDS.executive:
      return ADMIN_CAPABILITY_IDS.executive;
    default:
      throw new Error(`Unknown admin agent ${agentId}`);
  }
}

// ---------------------------------------------------------------------------
// Platform mirror definitions
// ---------------------------------------------------------------------------

/**
 * Platform mirror definitions for the admin runtime agents
 * (AG-501..AG-505). Tool access is an explicit policy layer on top: every
 * admin agent ships v1 with an empty allowlist (fail-closed), so agentic tool
 * calling is refused until a read-only tool is explicitly enabled at
 * composition. Permissions reflect the Admin memory/knowledge matrix
 * (memory.read + knowledge.read within admin scopes only).
 */
export function createAdminTeamAgentDefinitions(): readonly AgentDefinition[] {
  const limits = {
    maxExecutionTimeMs: 60_000,
    maxReasoningTurns: 0,
    maxToolCalls: 0,
    maxContextBytes: 32_768,
    maxOutputBytes: 32_768,
    maxConcurrentExecutions: 2,
  };
  return [
    {
      agentId: ADMIN_AGENT_IDS.analytics,
      name: 'Analytics Agent',
      version: ADMIN_TEAM_VERSION,
      description:
        'Interprets F21 data questions into measure definitions and chart kinds; never fabricates platform metrics (deterministic v1).',
      team: ADMIN_TEAM_GROUP,
      category: AgentCategory.Admin,
      status: AgentStatus.InDevelopment,
      capabilities: [
        capability(ADMIN_CAPABILITY_IDS.analytics),
        capability(ADMIN_CAPABILITY_IDS.action),
      ],
      executionModes: [AgentExecutionMode.Deterministic],
      allowedTools: [],
      permissions: ['memory.read', 'knowledge.read', ADMIN_CAPABILITY_IDS.analytics],
      limits,
      dependencies: [],
      configuration: {},
    },
    {
      agentId: ADMIN_AGENT_IDS.fraudMonitoring,
      name: 'Fraud Monitoring Agent',
      version: ADMIN_TEAM_VERSION,
      description:
        'Triage supplied fraud signals with SLA deadlines; no automated ban ever executes (deterministic v1, BR-ADM-2, AC-22).',
      team: ADMIN_TEAM_GROUP,
      category: AgentCategory.Admin,
      status: AgentStatus.InDevelopment,
      capabilities: [capability(ADMIN_CAPABILITY_IDS.fraud)],
      executionModes: [AgentExecutionMode.Deterministic],
      allowedTools: [],
      permissions: ['memory.read', 'knowledge.read', ADMIN_CAPABILITY_IDS.fraud],
      limits,
      dependencies: [
        {
          type: DependencyType.Agent,
          id: ADMIN_AGENT_IDS.analytics,
          required: false,
        },
      ],
      configuration: {},
    },
    {
      agentId: ADMIN_AGENT_IDS.platformHealth,
      name: 'Platform Health Agent',
      version: ADMIN_TEAM_VERSION,
      description:
        'Assesses only observed platform metrics/SLOs and service topology; never derives health from missing data (deterministic v1).',
      team: ADMIN_TEAM_GROUP,
      category: AgentCategory.Admin,
      status: AgentStatus.Draft,
      capabilities: [capability(ADMIN_CAPABILITY_IDS.health)],
      executionModes: [AgentExecutionMode.Deterministic],
      allowedTools: [],
      permissions: ['memory.read', 'knowledge.read', ADMIN_CAPABILITY_IDS.health],
      limits,
      dependencies: [
        {
          type: DependencyType.Agent,
          id: ADMIN_AGENT_IDS.analytics,
          required: false,
        },
      ],
      configuration: {},
    },
    {
      agentId: ADMIN_AGENT_IDS.aiOperations,
      name: 'AI Operations Agent',
      version: ADMIN_TEAM_VERSION,
      description:
        'Reviews proposed AI-ecosystem changes as reversible, approval-gated rollouts; never executes them (deterministic v1, BR-ADM-2/4).',
      team: ADMIN_TEAM_GROUP,
      category: AgentCategory.Admin,
      status: AgentStatus.Draft,
      capabilities: [capability(ADMIN_CAPABILITY_IDS.aiOps)],
      executionModes: [AgentExecutionMode.Deterministic],
      allowedTools: [],
      permissions: ['memory.read', 'knowledge.read', ADMIN_CAPABILITY_IDS.aiOps],
      limits,
      dependencies: [
        {
          type: DependencyType.Agent,
          id: ADMIN_AGENT_IDS.analytics,
          required: false,
        },
      ],
      configuration: {},
    },
    {
      agentId: ADMIN_AGENT_IDS.executive,
      name: 'Executive Insights Agent',
      version: ADMIN_TEAM_VERSION,
      description:
        'Compiles executive reviews from supplied aggregated KPI facts only; row-level data and fabricated totals are never exposed (deterministic v1).',
      team: ADMIN_TEAM_GROUP,
      category: AgentCategory.Admin,
      status: AgentStatus.Draft,
      capabilities: [capability(ADMIN_CAPABILITY_IDS.executive)],
      executionModes: [AgentExecutionMode.Deterministic],
      allowedTools: [],
      permissions: ['memory.read', 'knowledge.read', ADMIN_CAPABILITY_IDS.executive],
      limits,
      dependencies: [
        {
          type: DependencyType.Agent,
          id: ADMIN_AGENT_IDS.analytics,
          required: false,
        },
        {
          type: DependencyType.Agent,
          id: ADMIN_AGENT_IDS.fraudMonitoring,
          required: false,
        },
        {
          type: DependencyType.Agent,
          id: ADMIN_AGENT_IDS.platformHealth,
          required: false,
        },
      ],
      configuration: {},
    },
  ];
}

// ---------------------------------------------------------------------------
// Small deterministic helpers
// ---------------------------------------------------------------------------

function cancelled(agentId: string): RuntimeAgentExecutionResult {
  return {
    success: false,
    error: {
      code: 'EXECUTION_CANCELLED',
      message: `Agent ${agentId} stopped after cancellation`,
      retryable: false,
    },
  };
}

function wait(ms: number, context: RuntimeAgentExecutionContext): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    void context.signal.waitForCancellation().then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function clampDelay(value: number): number {
  return Math.min(Math.max(Math.trunc(value), 0), 5000);
}

function parseNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function asStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value.filter((item): item is string => typeof item === 'string');
  return items.length > 0 ? items : undefined;
}

function asObject(value: unknown): { readonly [key: string]: unknown } | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as { readonly [key: string]: unknown })
    : undefined;
}

function sanitizeRequired(value: unknown): string {
  return typeof value === 'string' ? sanitizeAdminText(value, 256) : '';
}

function sanitizeOptional(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const sanitized = sanitizeAdminText(value, ADMIN_MAX_DOCUMENT_BYTES);
  return sanitized.length === 0 ? undefined : sanitized;
}

function asDatasetArray(
  value: unknown,
): readonly { readonly scope: string; readonly dataset: string }[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value
    .map(asObject)
    .filter((entry): entry is { readonly [key: string]: unknown } => entry !== undefined)
    .map((entry) => ({
      scope: sanitizeOptional(entry['scope']) ?? '',
      dataset: sanitizeOptional(entry['dataset']) ?? '',
    }));
  return items.length > 0 ? items : undefined;
}

function asKpiFacts(value: unknown): readonly AdminKpiFacts[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value
    .map(asObject)
    .filter((entry): entry is { readonly [key: string]: unknown } => entry !== undefined)
    .map((entry) => ({
      name: sanitizeOptional(entry['name']) ?? '',
      value: typeof entry['value'] === 'number' ? entry['value'] : Number.NaN,
      unit: sanitizeOptional(entry['unit']),
      period: sanitizeOptional(entry['period']),
      note: sanitizeOptional(entry['note']),
    }))
    .filter((entry) => entry.name.length > 0 && Number.isFinite(entry.value));
  return items.length > 0 ? items : undefined;
}

function asSignalArray(value: unknown):
  | readonly {
      readonly signalId: string;
      readonly signalType?: string;
      readonly severity?: string;
      readonly observedAt: string;
      readonly evidence: readonly { readonly label?: string; readonly detail?: string }[];
    }[]
  | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value
    .map(asObject)
    .filter((entry): entry is { readonly [key: string]: unknown } => entry !== undefined)
    .map((entry) => ({
      signalId: sanitizeOptional(entry['signalId']) ?? '',
      signalType: sanitizeOptional(entry['signalType']),
      severity: sanitizeOptional(entry['severity']),
      observedAt: sanitizeOptional(entry['observedAt']) ?? '',
      evidence: asEvidenceArray(entry['evidence']) ?? [],
    }))
    .filter((entry) => entry.signalId.length > 0 && entry.observedAt.length > 0);
  return items.length > 0 ? items : undefined;
}

function asEvidenceArray(
  value: unknown,
): readonly { readonly label?: string; readonly detail?: string }[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value
    .map(asObject)
    .filter((entry): entry is { readonly [key: string]: unknown } => entry !== undefined)
    .map((entry) => ({
      label: sanitizeOptional(entry['label']),
      detail: sanitizeOptional(entry['detail']),
    }));
  return items.length > 0 ? items : undefined;
}

function asMetricArray(value: unknown):
  | readonly {
      readonly name: string;
      readonly value: number;
      readonly unit?: string;
      readonly threshold?: number;
      readonly observedAt?: string;
    }[]
  | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value
    .map(asObject)
    .filter((entry): entry is { readonly [key: string]: unknown } => entry !== undefined)
    .map((entry) => ({
      name: sanitizeOptional(entry['name']) ?? '',
      value: typeof entry['value'] === 'number' ? entry['value'] : Number.NaN,
      unit: sanitizeOptional(entry['unit']),
      threshold: typeof entry['threshold'] === 'number' ? entry['threshold'] : undefined,
      observedAt: sanitizeOptional(entry['observedAt']),
    }))
    .filter((entry) => entry.name.length > 0 && Number.isFinite(entry.value));
  return items.length > 0 ? items : undefined;
}

function asTopologyArray(
  value: unknown,
): readonly { readonly service: string; readonly healthy?: boolean }[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value
    .map(asObject)
    .filter((entry): entry is { readonly [key: string]: unknown } => entry !== undefined)
    .map((entry) => ({
      service: sanitizeOptional(entry['service']) ?? '',
      healthy: typeof entry['healthy'] === 'boolean' ? entry['healthy'] : undefined,
    }))
    .filter((entry) => entry.service.length > 0);
  return items.length > 0 ? items : undefined;
}

function asChangeObject(value: unknown):
  | {
      readonly changeType: 'feature-flag' | 'model-route' | 'prompt-version' | 'cost-cap';
      readonly target: string;
      readonly value?: string;
      readonly reversible?: boolean;
      readonly reason?: string;
    }
  | undefined {
  const entry = asObject(value);
  if (entry === undefined) {
    return undefined;
  }
  const changeType = entry['changeType'];
  const target = sanitizeOptional(entry['target']) ?? '';
  if (
    (changeType !== 'feature-flag' &&
      changeType !== 'model-route' &&
      changeType !== 'prompt-version' &&
      changeType !== 'cost-cap') ||
    target.length === 0
  ) {
    return undefined;
  }
  return {
    changeType,
    target,
    value: sanitizeOptional(entry['value']),
    reversible: typeof entry['reversible'] === 'boolean' ? entry['reversible'] : undefined,
    reason: sanitizeOptional(entry['reason']),
  };
}
