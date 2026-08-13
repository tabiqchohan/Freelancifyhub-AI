import type { ConditionEvaluator } from '../interfaces/index.js';
import type { ConditionEvaluationContext } from '../interfaces/index.js';
import type { ExecutionCondition } from '../../planning/types/index.js';
import { ConditionOperator } from '../../planning/types/index.js';

/**
 * Deterministic condition evaluator (prompt §8). Evaluates declarative
 * conditions only; never makes external calls and never uses LLMs.
 */
export class DeterministicConditionEvaluator implements ConditionEvaluator {
  private readonly conditions: ReadonlyMap<string, ExecutionCondition>;

  constructor(conditions: readonly ExecutionCondition[] = []) {
    this.conditions = new Map(conditions.map((condition) => [condition.id, condition]));
  }

  evaluate(condition: ExecutionCondition, context: ConditionEvaluationContext): boolean {
    switch (condition.operator) {
      case ConditionOperator.Equals:
        return this.compare(context.resolve(condition.field ?? ''), condition.value, 'equals');
      case ConditionOperator.NotEquals:
        return !this.compare(context.resolve(condition.field ?? ''), condition.value, 'equals');
      case ConditionOperator.GreaterThan:
        return this.compare(context.resolve(condition.field ?? ''), condition.value, 'gt');
      case ConditionOperator.LessThan:
        return this.compare(context.resolve(condition.field ?? ''), condition.value, 'lt');
      case ConditionOperator.Exists:
        return this.isPresent(context.resolve(condition.field ?? ''));
      case ConditionOperator.NotExists:
        return !this.isPresent(context.resolve(condition.field ?? ''));
      case ConditionOperator.Matches:
        return this.matches(context.resolve(condition.field ?? ''), condition.value);
      case ConditionOperator.And:
        return this.and(condition, context);
      case ConditionOperator.Or:
        return this.or(condition, context);
      case ConditionOperator.Not: {
        const child = this.child(condition, 0);
        return child === undefined ? false : !this.evaluate(child, context);
      }
      default:
        return false;
    }
  }

  private child(condition: ExecutionCondition, index: number): ExecutionCondition | undefined {
    const id = (condition.children ?? [])[index];
    return id === undefined ? undefined : this.conditions.get(id);
  }

  private and(condition: ExecutionCondition, context: ConditionEvaluationContext): boolean {
    const children = condition.children ?? [];
    if (children.length === 0) {
      return false;
    }
    for (const id of children) {
      const child = this.conditions.get(id);
      if (child === undefined || !this.evaluate(child, context)) {
        return false;
      }
    }
    return true;
  }

  private or(condition: ExecutionCondition, context: ConditionEvaluationContext): boolean {
    const children = condition.children ?? [];
    if (children.length === 0) {
      return false;
    }
    for (const id of children) {
      const child = this.conditions.get(id);
      if (child !== undefined && this.evaluate(child, context)) {
        return true;
      }
    }
    return false;
  }

  private isPresent(value: unknown): boolean {
    return value !== undefined && value !== null && value !== '';
  }

  private compare(actual: unknown, expected: unknown, kind: 'equals' | 'gt' | 'lt'): boolean {
    if (typeof actual === 'number' && typeof expected === 'number') {
      if (kind === 'gt') {
        return actual > expected;
      }
      if (kind === 'lt') {
        return actual < expected;
      }
      return actual === expected;
    }

    if (typeof expected === 'string') {
      if (kind === 'gt' && typeof actual === 'string') {
        return actual > expected;
      }
      if (kind === 'lt' && typeof actual === 'string') {
        return actual < expected;
      }
      return String(actual) === expected;
    }

    if (kind === 'equals') {
      return actual === expected;
    }

    return false;
  }

  private matches(actual: unknown, value: unknown): boolean {
    if (typeof value !== 'string' || typeof actual !== 'string') {
      return false;
    }
    try {
      return new RegExp(value).test(actual);
    } catch {
      return false;
    }
  }
}

export type { ConditionEvaluationContext };
