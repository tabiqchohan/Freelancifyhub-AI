import { describe, expect, it } from 'vitest';

import { DeterministicConditionEvaluator } from '../../../../../src/agents/ag-001-master-orchestrator/execution/conditions/index.js';
import { ConditionOperator } from '../../../../../src/agents/ag-001-master-orchestrator/planning/types/index.js';
import type { ExecutionCondition } from '../../../../../src/agents/ag-001-master-orchestrator/planning/types/index.js';

function context(store: Readonly<Record<string, unknown>>): {
  readonly resolve: (field: string) => unknown | undefined;
} {
  return { resolve: (field: string) => store[field] };
}

describe('DeterministicConditionEvaluator', () => {
  const evaluator = new DeterministicConditionEvaluator();

  it('evaluates equality', () => {
    const condition: ExecutionCondition = {
      id: 'c1',
      operator: ConditionOperator.Equals,
      field: 'route.confidence',
      value: 0.9,
    };
    expect(evaluator.evaluate(condition, context({ 'route.confidence': 0.9 }))).toBe(true);
    expect(evaluator.evaluate(condition, context({ 'route.confidence': 0.1 }))).toBe(false);
  });

  it('evaluates not-equals', () => {
    const condition: ExecutionCondition = {
      id: 'c2',
      operator: ConditionOperator.NotEquals,
      field: 'level',
      value: 'admin',
    };
    expect(evaluator.evaluate(condition, context({ level: 'user' }))).toBe(true);
    expect(evaluator.evaluate(condition, context({ level: 'admin' }))).toBe(false);
  });

  it('evaluates greater-than and less-than', () => {
    const gt: ExecutionCondition = {
      id: 'c3',
      operator: ConditionOperator.GreaterThan,
      field: 'score',
      value: 5,
    };
    const lt: ExecutionCondition = {
      id: 'c4',
      operator: ConditionOperator.LessThan,
      field: 'score',
      value: 5,
    };
    expect(evaluator.evaluate(gt, context({ score: 6 }))).toBe(true);
    expect(evaluator.evaluate(lt, context({ score: 4 }))).toBe(true);
    expect(evaluator.evaluate(gt, context({ score: 5 }))).toBe(false);
  });

  it('evaluates existential operators', () => {
    const exists: ExecutionCondition = {
      id: 'c5',
      operator: ConditionOperator.Exists,
      field: 'token',
    };
    const missing: ExecutionCondition = {
      id: 'c6',
      operator: ConditionOperator.NotExists,
      field: 'token',
    };
    expect(evaluator.evaluate(exists, context({ token: 'abc' }))).toBe(true);
    expect(evaluator.evaluate(exists, context({}))).toBe(false);
    expect(evaluator.evaluate(missing, context({}))).toBe(true);
  });

  it('evaluates regex matches', () => {
    const condition: ExecutionCondition = {
      id: 'c7',
      operator: ConditionOperator.Matches,
      field: 'email',
      value: '^[^@]+@[^@]+$',
    };
    expect(evaluator.evaluate(condition, context({ email: 'a@b.com' }))).toBe(true);
    expect(evaluator.evaluate(condition, context({ email: 'nope' }))).toBe(false);
  });

  it('evaluates AND/OR/NOT composed conditions deterministically', () => {
    const a: ExecutionCondition = {
      id: 'a',
      operator: ConditionOperator.GreaterThan,
      field: 'score',
      value: 3,
    };
    const b: ExecutionCondition = {
      id: 'b',
      operator: ConditionOperator.LessThan,
      field: 'score',
      value: 10,
    };
    const composed = new DeterministicConditionEvaluator([
      a,
      b,
      {
        id: 'and',
        operator: ConditionOperator.And,
        children: ['a', 'b'],
      },
      {
        id: 'or',
        operator: ConditionOperator.Or,
        children: ['a', 'b'],
      },
      {
        id: 'not-a',
        operator: ConditionOperator.Not,
        children: ['a'],
      },
    ]);

    expect(
      composed.evaluate(
        { id: 'and', operator: ConditionOperator.And, children: ['a', 'b'] },
        context({ score: 5 }),
      ),
    ).toBe(true);
    expect(
      composed.evaluate(
        { id: 'and', operator: ConditionOperator.And, children: ['a', 'b'] },
        context({ score: 20 }),
      ),
    ).toBe(false);
    expect(
      composed.evaluate(
        { id: 'or', operator: ConditionOperator.Or, children: ['a', 'b'] },
        context({ score: 20 }),
      ),
    ).toBe(true);
    expect(
      composed.evaluate(
        { id: 'not-a', operator: ConditionOperator.Not, children: ['a'] },
        context({ score: 1 }),
      ),
    ).toBe(true);
  });

  it('falls back to false for unknown operators', () => {
    const condition: ExecutionCondition = {
      id: 'c8',
      operator: 'WHAT' as ConditionOperator,
      field: 'x',
      value: 1,
    };
    expect(evaluator.evaluate(condition, context({ x: 1 }))).toBe(false);
  });
});
