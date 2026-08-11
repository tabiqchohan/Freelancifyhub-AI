import { describe, expect, it } from 'vitest';

import {
  RoutingError,
  RoutingValidationError,
  RoutingRegistryError,
  NoRouteError,
  LowConfidenceRouteError,
  AgentUnavailableError,
  RoutingConstraintError,
  RoutingConfigError,
} from '../../../../../src/agents/ag-001-master-orchestrator/routing/errors/index.js';
import { OrchestratorError } from '../../../../../src/agents/ag-001-master-orchestrator/errors/index.js';

describe('routing error hierarchy', () => {
  it('is a subclass of OrchestratorError', () => {
    expect(new RoutingError('boom')).toBeInstanceOf(OrchestratorError);
    expect(new RoutingError('boom')).toBeInstanceOf(Error);
  });

  it('assigns a default code to the base error', () => {
    const error = new RoutingError('boom');

    expect(error.code).toBe('ROUTING_ERROR');
    expect(error.retryable).toBe(false);
  });

  it('assigns typed codes to subclasses', () => {
    expect(new RoutingValidationError('x').code).toBe('ROUTING_VALIDATION_ERROR');
    expect(new RoutingRegistryError('x').code).toBe('ROUTING_REGISTRY_ERROR');
    expect(new NoRouteError('x').code).toBe('NO_ROUTE_ERROR');
    expect(new LowConfidenceRouteError('x').code).toBe('LOW_CONFIDENCE_ROUTE_ERROR');
    expect(new AgentUnavailableError('x').code).toBe('AGENT_UNAVAILABLE_ERROR');
    expect(new RoutingConstraintError('x').code).toBe('ROUTING_CONSTRAINT_ERROR');
    expect(new RoutingConfigError('x').code).toBe('ROUTING_CONFIG_ERROR');
  });

  it('marks transient errors as retryable', () => {
    expect(new LowConfidenceRouteError('x').retryable).toBe(true);
    expect(new AgentUnavailableError('x').retryable).toBe(true);
  });

  it('carries details and custom codes', () => {
    const error = new NoRouteError('no route', {
      code: 'CUSTOM',
      details: { intentId: 'project.create' },
    });

    expect(error.code).toBe('CUSTOM');
    expect(error.details).toEqual({ intentId: 'project.create' });
  });

  it('preserves the subclass name', () => {
    expect(new AgentUnavailableError('x').name).toBe('AgentUnavailableError');
  });
});
