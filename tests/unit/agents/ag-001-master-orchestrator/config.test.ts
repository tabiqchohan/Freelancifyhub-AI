import { describe, expect, it } from 'vitest';

import { parseOrchestratorConfig } from '../../../../src/agents/ag-001-master-orchestrator/config/index.js';
import { validateOrchestratorConfig } from '../../../../src/agents/ag-001-master-orchestrator/validators/config.validator.js';

describe('orchestrator configuration', () => {
  it('applies defaults when no variables are present', () => {
    const config = parseOrchestratorConfig({} as NodeJS.ProcessEnv);

    expect(config.ORCHESTRATOR_NAME).toBe('master-orchestrator');
    expect(config.ORCHESTRATOR_TIMEOUT_MS).toBe(20000);
    expect(config.ORCHESTRATOR_LONG_TIMEOUT_MS).toBe(60000);
    expect(config.ORCHESTRATOR_RETRY_MAX).toBe(3);
    expect(config.ORCHESTRATOR_RETRY_BASE_MS).toBe(500);
    expect(config.ORCHESTRATOR_APPROVAL_GATE).toBe(true);
  });

  it('parses explicit string values and coerces numbers', () => {
    const config = parseOrchestratorConfig({
      ORCHESTRATOR_TIMEOUT_MS: '15000',
      ORCHESTRATOR_RETRY_MAX: '2',
      ORCHESTRATOR_APPROVAL_GATE: 'false',
    } as NodeJS.ProcessEnv);

    expect(config.ORCHESTRATOR_TIMEOUT_MS).toBe(15000);
    expect(config.ORCHESTRATOR_RETRY_MAX).toBe(2);
    expect(config.ORCHESTRATOR_APPROVAL_GATE).toBe(false);
  });

  it('rejects a non-integer timeout', () => {
    expect(() =>
      parseOrchestratorConfig({ ORCHESTRATOR_TIMEOUT_MS: 'fast' } as NodeJS.ProcessEnv),
    ).toThrowError('Invalid orchestrator configuration');
  });

  it('rejects a retry count above the allowed bound', () => {
    expect(() =>
      parseOrchestratorConfig({ ORCHESTRATOR_RETRY_MAX: '25' } as NodeJS.ProcessEnv),
    ).toThrow();
  });

  it('validates configuration values through the dedicated validator', () => {
    const config = validateOrchestratorConfig({
      ORCHESTRATOR_TIMEOUT_MS: '10000',
    });

    expect(config.ORCHESTRATOR_TIMEOUT_MS).toBe(10000);
  });
});
