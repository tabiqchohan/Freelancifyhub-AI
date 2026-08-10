import { describe, expect, it } from 'vitest';

import { RuleBasedIntentClassifier } from '../../../../../src/agents/ag-001-master-orchestrator/intent/classifiers/index.js';
import { IntentValidationError } from '../../../../../src/agents/ag-001-master-orchestrator/intent/errors.js';
import {
  IntentCategory,
  IntentId,
  IntentPriority,
  IntentStatus,
  UserRole,
  type IntentDefinition,
} from '../../../../../src/agents/ag-001-master-orchestrator/intent/types.js';
import {
  validateIntentDefinition,
  validateIntentInput,
  validateIntentResult,
} from '../../../../../src/agents/ag-001-master-orchestrator/intent/validators.js';

const classifier = new RuleBasedIntentClassifier();

function definition(overrides: Partial<IntentDefinition> = {}): IntentDefinition {
  return {
    id: IntentId.CREATE_PROJECT,
    name: 'Create Project',
    description: 'd',
    category: IntentCategory.Projects,
    priority: IntentPriority.High,
    allowedRoles: [UserRole.Freelancer],
    confidenceThreshold: 0.5,
    supportedAgents: ['AG-101'],
    status: IntentStatus.Active,
    ...overrides,
  };
}

describe('validateIntentInput', () => {
  it('accepts a valid string', () => {
    const value = 'create project';

    expect(() => validateIntentInput(value)).not.toThrow();
    expect(typeof value).toBe('string');
  });

  it('rejects blank and non-string input', () => {
    expect(() => validateIntentInput('')).toThrowError(IntentValidationError);
    expect(() => validateIntentInput('   ')).toThrowError(IntentValidationError);
    expect(() => validateIntentInput(42 as never)).toThrowError(IntentValidationError);
  });
});

describe('validateIntentDefinition', () => {
  it('accepts a complete definition', () => {
    expect(() => validateIntentDefinition(definition())).not.toThrow();
  });

  it('rejects an unknown intent id', () => {
    expect(() =>
      validateIntentDefinition(definition({ id: 'project.bogus' as IntentId })),
    ).toThrowError(IntentValidationError);
  });

  it('rejects an empty name', () => {
    expect(() => validateIntentDefinition(definition({ name: ' ' }))).toThrowError(
      IntentValidationError,
    );
  });

  it('rejects an out-of-range threshold', () => {
    expect(() => validateIntentDefinition(definition({ confidenceThreshold: 1.2 }))).toThrowError(
      IntentValidationError,
    );
  });

  it('rejects an unknown role', () => {
    expect(() =>
      validateIntentDefinition(definition({ allowedRoles: ['Zombie' as UserRole] })),
    ).toThrowError(IntentValidationError);
  });
});

describe('validateIntentResult', () => {
  it('accepts a classifier result', () => {
    const result = classifier.classify('create project');

    expect(() => validateIntentResult(result)).not.toThrow();
  });

  it('round-trips a fallback result', () => {
    const result = classifier.classify('');

    expect(() => validateIntentResult(result)).not.toThrow();
  });

  it('rejects malformed output', () => {
    expect(() => validateIntentResult({ primary: 'nope' } as never)).toThrowError(
      IntentValidationError,
    );
  });
});
