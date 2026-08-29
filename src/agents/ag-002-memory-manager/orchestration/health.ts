import type { EventLogContract } from '../events/index.js';
import type { OrchestrationMemoryCapabilities } from './contracts.js';
import type { OrchestrationMemoryMetricSink } from './metrics-types.js';

/**
 * Sprint 8 — integration health (prompt §14).
 *
 * Truthful, capability-aware health. A capability is only reported as
 * available when the corresponding dependency is actually present and the
 * feature flag is enabled. The integration never claims a capability it does
 * not implement.
 */
export interface OrchestrationMemoryHealth {
  readonly integration: {
    readonly enabled: boolean;
    readonly available: boolean;
    readonly retrievalAvailable: boolean;
    readonly contextIntegrationAvailable: boolean;
    readonly eventLogAvailable: boolean;
    readonly storageAvailable: boolean;
  };
  readonly checkedAt: string;
  readonly message: string;
}

export interface OrchestrationMemoryHealthOptions {
  readonly enabled: boolean;
  readonly retrievalServiceAvailable: boolean;
  readonly contextIntegrationAvailable: boolean;
  readonly eventLog?: EventLogContract | null;
  readonly storageAvailable: boolean;
}

/** Builds a truthful integration health snapshot. */
export function buildIntegrationHealth(
  options: OrchestrationMemoryHealthOptions,
  nowIso: string,
): OrchestrationMemoryHealth {
  const enabled = options.enabled;
  const available =
    enabled &&
    options.retrievalServiceAvailable &&
    options.contextIntegrationAvailable &&
    options.storageAvailable;

  return {
    integration: {
      enabled,
      available,
      retrievalAvailable: enabled && options.retrievalServiceAvailable,
      contextIntegrationAvailable: enabled && options.contextIntegrationAvailable,
      eventLogAvailable: options.eventLog !== undefined && options.eventLog !== null,
      storageAvailable: options.storageAvailable,
    },
    checkedAt: nowIso,
    message: available
      ? 'memory integration available'
      : enabled
        ? 'memory integration enabled but not fully available'
        : 'memory integration disabled',
  };
}

/** Threads current metrics into a health snapshot for observability. */
export function withMetrics(
  health: OrchestrationMemoryHealth,
  metrics: OrchestrationMemoryMetricSink,
): OrchestrationMemoryHealth & { metrics: ReturnType<OrchestrationMemoryMetricSink['snapshot']> } {
  return { ...health, metrics: metrics.snapshot() };
}

/** Builds capability reporting from health (prompt §2, §6). */
export function buildCapabilities(
  health: OrchestrationMemoryHealth,
  writeBack: string,
): OrchestrationMemoryCapabilities {
  return {
    enabled: health.integration.enabled,
    available: health.integration.available,
    retrievalAvailable: health.integration.retrievalAvailable,
    contextIntegrationAvailable: health.integration.contextIntegrationAvailable,
    eventLogAvailable: health.integration.eventLogAvailable,
    storageAvailable: health.integration.storageAvailable,
    writeBack: writeBack as OrchestrationMemoryCapabilities['writeBack'],
  };
}
