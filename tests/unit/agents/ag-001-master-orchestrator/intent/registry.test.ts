import { describe, expect, it } from 'vitest';

import { IntentRegistry } from '../../../../../src/agents/ag-001-master-orchestrator/intent/registry/index.js';
import { intentRegistry } from '../../../../../src/agents/ag-001-master-orchestrator/intent/registry/index.js';
import { IntentRegistryError } from '../../../../../src/agents/ag-001-master-orchestrator/intent/errors.js';
import {
  IntentCategory,
  IntentId,
  IntentPriority,
  IntentStatus,
  UserRole,
  type IntentDefinition,
} from '../../../../../src/agents/ag-001-master-orchestrator/intent/types.js';

function makeDefinition(overrides: Partial<IntentDefinition> = {}): IntentDefinition {
  return {
    id: IntentId.UNKNOWN,
    name: 'Test',
    description: 'test',
    category: IntentCategory.System,
    priority: IntentPriority.Low,
    allowedRoles: [UserRole.Client],
    confidenceThreshold: 0.5,
    supportedAgents: [],
    status: IntentStatus.Active,
    ...overrides,
  };
}

describe('IntentRegistry', () => {
  it('contains every intent id from the architecture', () => {
    const ids = Object.values(IntentId);

    for (const id of ids) {
      expect(intentRegistry.has(id)).toBe(true);
    }
  });

  it('registers unique ids', () => {
    const registry = new IntentRegistry();
    const all = registry.getAll();

    expect(new Set(all.map((d) => d.id)).size).toBe(all.length);
  });

  it('rejects duplicate intent ids', () => {
    const first = makeDefinition({ id: IntentId.CREATE_PROJECT });
    const second = makeDefinition({ id: IntentId.CREATE_PROJECT });

    expect(() => new IntentRegistry([first, second])).toThrowError(IntentRegistryError);
  });

  it('rejects a keyword shared by two intents', () => {
    const keywordMap = {
      [IntentId.CREATE_PROJECT]: ['create project'],
      [IntentId.UPDATE_PROJECT]: ['create project'],
    } as unknown as Record<IntentId, readonly string[]>;

    const definitions = [
      makeDefinition({ id: IntentId.CREATE_PROJECT }),
      makeDefinition({ id: IntentId.UPDATE_PROJECT }),
    ];

    expect(() => new IntentRegistry(definitions, keywordMap)).toThrowError(IntentRegistryError);
  });

  it('looks up definitions and keywords by id', () => {
    const definition = intentRegistry.get(IntentId.CREATE_PROJECT);

    expect(definition?.name).toBe('Create Project');
    expect(intentRegistry.getKeywords(IntentId.CREATE_PROJECT).length).toBeGreaterThan(0);
  });

  it('returns undefined for an unknown id', () => {
    expect(intentRegistry.get(IntentId.SYSTEM)).toBeDefined();
  });
});
