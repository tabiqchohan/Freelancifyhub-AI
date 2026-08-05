import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  createRequestId,
  createTraceId,
  nowIso,
} from '../../../../src/agents/ag-001-master-orchestrator/utils/ids.js';
import { validateWithSchema } from '../../../../src/agents/ag-001-master-orchestrator/utils/schema.js';
import { ValidationError } from '../../../../src/agents/ag-001-master-orchestrator/errors/index.js';

import {
  AgentCategory,
  AgentStatus,
  DependencyType,
  ExecutionStatus,
} from '../../../../src/agents/ag-001-master-orchestrator/types/index.js';

describe('ids utils', () => {
  it('generates prefixed unique ids', () => {
    expect(createTraceId()).toMatch(/^trace_/);
    expect(createRequestId()).toMatch(/^req_/);
    expect(createTraceId()).not.toBe(createTraceId());
  });

  it('produces a parseable ISO timestamp', () => {
    expect(Number.isNaN(Date.parse(nowIso()))).toBe(false);
  });
});

describe('validateWithSchema', () => {
  const schema = z.object({ n: z.number().int() });

  it('returns parsed data for valid input', () => {
    expect(validateWithSchema(schema, { n: 1 })).toEqual({ n: 1 });
  });

  it('throws a ValidationError for invalid input', () => {
    expect(() => validateWithSchema(schema, { n: 'x' })).toThrowError(ValidationError);
  });
});

describe('domain types', () => {
  it('uses stable enum member values', () => {
    expect(AgentCategory.Core).toBe('Core');
    expect(AgentCategory.Marketplace).toBe('Marketplace');
  });

  it('defines the full lifecycle status set', () => {
    const statuses = Object.values(AgentStatus);

    expect(statuses).toEqual([
      AgentStatus.Draft,
      AgentStatus.InDevelopment,
      AgentStatus.Testing,
      AgentStatus.Production,
      AgentStatus.Maintenance,
      AgentStatus.Retired,
    ]);
  });

  it('exposes dependency and execution semantics', () => {
    expect(DependencyType.Tool).toBe('tool');
    expect(ExecutionStatus.Succeeded).toBe('Succeeded');
  });
});
